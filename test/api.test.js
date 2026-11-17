'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');

/** Fake upstream: Open-Meteo AQ, geocoding and Gemini. No network in tests. */
function makeFetch({ geminiFails = false } = {}) {
  const calls = [];
  const json = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });
  const fn = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    const u = String(url);
    if (u.includes('air-quality-api.open-meteo.com')) {
      const start = Date.now() + 3600_000;
      const time = Array.from({ length: 24 }, (_, i) => new Date(start + i * 3600_000).toISOString().slice(0, 16));
      return json({
        timezone: 'Asia/Kolkata',
        current: { us_aqi: 312, pm2_5: 210, pm10: 340, nitrogen_dioxide: 70, ozone: 15, carbon_monoxide: 1500 },
        hourly: { time, us_aqi: time.map((_, i) => 250 + ((i * 37) % 90)), pm2_5: time.map(() => 150) }
      });
    }
    if (u.includes('geocoding-api.open-meteo.com')) {
      return json({ results: [{ name: 'New Delhi', admin1: 'Delhi', country: 'India', latitude: 28.61, longitude: 77.21 }] });
    }
    if (u.includes('generativelanguage.googleapis.com')) {
      if (geminiFails) return json({}, false, 500);
      const body = JSON.parse(opts.body);
      const isPlan = body.generationConfig.responseMimeType === 'application/json';
      const text = isPlan
        ? JSON.stringify({
            headline: 'Hazardous air — stay in',
            summary: 'Stay indoors.',
            routine: [{ time: '7am', action: 'Keep windows shut', why: 'Inversion' }],
            indoorHacks: [{ tip: 'Box-fan filter', impact: 'Halves PM2.5', cost: 'low' }],
            sustainableSwaps: [{ swap: 'Take metro', impact: '61.6 kg CO2/month' }],
            healthAlert: 'Kids indoors.'
          })
        : 'Keep the kids indoors today.';
      return json({ candidates: [{ content: { parts: [{ text }] } }] });
    }
    throw new Error(`Unexpected URL ${u}`);
  };
  fn.calls = calls;
  return fn;
}

async function startServer(opts) {
  const fetchImpl = makeFetch(opts);
  const app = createApp({ config: { geminiApiKey: opts.key, googleApiKey: '', rateLimitPerMin: opts.limit ?? 1000 }, fetchImpl });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  return { server, base: `http://127.0.0.1:${server.address().port}`, fetchImpl };
}

const post = (base, path, body) =>
  fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

describe('API with Gemini', () => {
  let ctx;
  before(async () => { ctx = await startServer({ key: 'test-key' }); });
  after(() => ctx.server.close());

  test('health reports AI enabled', async () => {
    const r = await fetch(`${ctx.base}/api/health`);
    assert.deepEqual(await r.json(), { status: 'ok', ai: true, aqSource: 'open-meteo' });
  });

  test('sets security headers', async () => {
    const r = await fetch(`${ctx.base}/api/health`);
    assert.ok(r.headers.get('content-security-policy'));
    assert.equal(r.headers.get('x-powered-by'), null);
  });

  test('POST /api/plan returns AQ, impacts and Gemini plan', async () => {
    const r = await post(ctx.base, '/api/plan', { lat: 28.61, lon: 77.21, place: 'Delhi', profile: { commuteMode: 'car_petrol', commuteKm: 10 } });
    assert.equal(r.status, 200);
    const data = await r.json();
    assert.equal(data.airQuality.aqi, 312);
    assert.equal(data.airQuality.category.level, 'Hazardous');
    assert.equal(data.plan.generatedBy, 'gemini');
    assert.ok(data.impacts.some((i) => i.id === 'commute_switch'));
    assert.ok(data.airQuality.hourly.length <= 24);
  });

  test('sends API key in header, not URL', () => {
    const g = ctx.fetchImpl.calls.find((c) => c.url.includes('generativelanguage'));
    assert.ok(!g.url.includes('test-key'));
    assert.equal(g.opts.headers['x-goog-api-key'], 'test-key');
  });

  test('caches air quality for nearby coordinates', async () => {
    const before = ctx.fetchImpl.calls.filter((c) => c.url.includes('air-quality-api')).length;
    await post(ctx.base, '/api/plan', { lat: 28.6101, lon: 77.2099, profile: {} });
    const afterCount = ctx.fetchImpl.calls.filter((c) => c.url.includes('air-quality-api')).length;
    assert.equal(afterCount, before);
  });

  test('POST /api/ask answers grounded question', async () => {
    const r = await post(ctx.base, '/api/ask', { lat: 28.61, lon: 77.21, profile: {}, question: 'Can kids play outside?' });
    assert.equal(r.status, 200);
    assert.match((await r.json()).answer, /indoors/);
  });

  test('geocode returns normalised results', async () => {
    const r = await fetch(`${ctx.base}/api/geocode?q=Delhi`);
    const { results } = await r.json();
    assert.equal(results[0].name, 'New Delhi, Delhi, India');
  });

  test('rejects invalid input with 400 and safe message', async () => {
    const r = await post(ctx.base, '/api/plan', { lat: 999, lon: 0, profile: {} });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /lat/);
  });

  test('rejects oversized bodies', async () => {
    const r = await post(ctx.base, '/api/ask', { lat: 1, lon: 1, question: 'x'.repeat(20_000) });
    assert.equal(r.status, 413);
  });

  test('unknown API routes 404 as JSON', async () => {
    const r = await fetch(`${ctx.base}/api/nope`);
    assert.equal(r.status, 404);
  });

  test('serves the accessible frontend', async () => {
    const html = await (await fetch(`${ctx.base}/`)).text();
    assert.match(html, /<html lang="en">/);
    assert.match(html, /skip-link/);
  });
});

describe('API resilience', () => {
  test('falls back to rule-based plan when Gemini errors', async () => {
    const ctx = await startServer({ key: 'k', geminiFails: true });
    try {
      const r = await post(ctx.base, '/api/plan', { lat: 19.07, lon: 72.87, profile: {} });
      const data = await r.json();
      assert.equal(r.status, 200);
      assert.equal(data.plan.generatedBy, 'rules');
    } finally {
      ctx.server.close();
    }
  });

  test('works without any API key', async () => {
    const ctx = await startServer({ key: '' });
    try {
      const data = await (await post(ctx.base, '/api/plan', { lat: 12.97, lon: 77.59, profile: {} })).json();
      assert.equal(data.plan.generatedBy, 'rules');
    } finally {
      ctx.server.close();
    }
  });

  test('rate limits abusive clients', async () => {
    const ctx = await startServer({ key: '', limit: 2 });
    try {
      await fetch(`${ctx.base}/api/health`);
      await fetch(`${ctx.base}/api/health`);
      const r = await fetch(`${ctx.base}/api/health`);
      assert.equal(r.status, 429);
    } finally {
      ctx.server.close();
    }
  });
});
