'use strict';

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const { getAirQuality } = require('./aqi');
const { computeImpacts } = require('./impact');
const { generatePlan, answerQuestion } = require('./gemini');
const { validateCoords, validateProfile, validateQuestion, validatePlaceQuery } = require('./validate');
const { TTLCache, coordKey } = require('./cache');

/**
 * Build the Express app. Dependencies are injectable for tests.
 * @param {{config?:object, fetchImpl?:Function}} deps
 */
function createApp({ config = {}, fetchImpl = globalThis.fetch } = {}) {
  const cfg = {
    geminiApiKey: config.geminiApiKey ?? process.env.GEMINI_API_KEY,
    geminiModel: config.geminiModel ?? process.env.GEMINI_MODEL ?? 'gemini-flash-latest',
    googleApiKey: config.googleApiKey ?? process.env.GOOGLE_MAPS_API_KEY,
    rateLimitPerMin: config.rateLimitPerMin ?? 30
  };
  const aqCache = new TTLCache({ ttlMs: 10 * 60_000 });
  const geoCache = new TTLCache({ ttlMs: 24 * 3600_000 });

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Cloud Run sits behind Google's front end

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'"],
          'style-src': ["'self'"],
          'img-src': ["'self'", 'data:'],
          'connect-src': ["'self'"]
        }
      }
    })
  );
  app.use(express.json({ limit: '10kb' }));
  app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h', etag: true }));

  const apiLimiter = rateLimit({ windowMs: 60_000, limit: cfg.rateLimitPerMin, standardHeaders: 'draft-7', legacyHeaders: false });
  app.use('/api/', apiLimiter);

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  async function airQualityFor(lat, lon) {
    const key = coordKey(lat, lon);
    let aq = aqCache.get(key);
    if (!aq) {
      aq = await getAirQuality(lat, lon, { googleApiKey: cfg.googleApiKey, fetchImpl });
      aqCache.set(key, aq);
    }
    return aq;
  }

  const placeName = (p) => (typeof p === 'string' ? p.slice(0, 100).replace(/[<>]/g, '') : undefined);

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', ai: Boolean(cfg.geminiApiKey), aqSource: cfg.googleApiKey ? 'google' : 'open-meteo' });
  });

  app.get('/api/geocode', wrap(async (req, res) => {
    const q = validatePlaceQuery(req.query.q);
    const cached = geoCache.get(q.toLowerCase());
    if (cached) return res.json(cached);
    const params = new URLSearchParams({ name: q, count: '5', language: 'en', format: 'json' });
    const r = await fetchImpl(`https://geocoding-api.open-meteo.com/v1/search?${params}`);
    if (!r.ok) throw Object.assign(new Error('Geocoding unavailable'), { status: 502 });
    const data = await r.json();
    const results = (data.results || []).map((x) => ({
      name: [x.name, x.admin1, x.country].filter(Boolean).join(', '),
      lat: x.latitude,
      lon: x.longitude
    }));
    geoCache.set(q.toLowerCase(), { results });
    res.json({ results });
  }));

  app.get('/api/air-quality', wrap(async (req, res) => {
    const { lat, lon } = validateCoords(req.query);
    res.json(await airQualityFor(lat, lon));
  }));

  app.post('/api/plan', wrap(async (req, res) => {
    const { lat, lon } = validateCoords(req.body);
    const profile = validateProfile(req.body.profile);
    const aq = await airQualityFor(lat, lon);
    const impacts = computeImpacts(profile, aq);
    const plan = await generatePlan({
      profile, aq, impacts, place: placeName(req.body.place),
      apiKey: cfg.geminiApiKey, model: cfg.geminiModel, fetchImpl
    });
    const { hourly, ...aqLite } = aq;
    res.json({ airQuality: { ...aqLite, hourly: hourly.slice(0, 24) }, impacts, plan });
  }));

  app.post('/api/ask', wrap(async (req, res) => {
    const { lat, lon } = validateCoords(req.body);
    const profile = validateProfile(req.body.profile);
    const question = validateQuestion(req.body.question);
    const aq = await airQualityFor(lat, lon);
    const impacts = computeImpacts(profile, aq);
    res.json(await answerQuestion({
      question, profile, aq, impacts, place: placeName(req.body.place),
      apiKey: cfg.geminiApiKey, model: cfg.geminiModel, fetchImpl
    }));
  }));

  app.use('/api/', (_req, res) => res.status(404).json({ error: 'Not found' }));

  // Centralised error handler: never leak stack traces.
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = err.status && err.status < 600 ? err.status : 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Something went wrong. Please try again.' : err.message });
  });

  return app;
}

module.exports = { createApp };
