'use strict';

/**
 * Air-quality data layer.
 * Primary source: Google Air Quality API (when GOOGLE_MAPS_API_KEY is set).
 * Fallback: Open-Meteo Air Quality API (free, no key).
 * Both are normalised into a single shape so the rest of the app never cares.
 */

const OPEN_METEO_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const GOOGLE_AQ_URL = 'https://airquality.googleapis.com/v1/currentConditions:lookup';
const GOOGLE_AQ_FORECAST_URL = 'https://airquality.googleapis.com/v1/forecast:lookup';

/** US EPA AQI bands. Text labels are always shown alongside colour (accessibility). */
const AQI_BANDS = [
  { max: 50, level: 'Good', color: '#2e7d32', advice: 'Air is clean. Enjoy outdoor activity.' },
  { max: 100, level: 'Moderate', color: '#9e7c00', advice: 'Unusually sensitive people should limit long outdoor exertion.' },
  { max: 150, level: 'Unhealthy for Sensitive Groups', color: '#c25e00', advice: 'Children, elderly and people with asthma or heart disease should reduce outdoor exertion.' },
  { max: 200, level: 'Unhealthy', color: '#c62828', advice: 'Everyone should reduce prolonged outdoor exertion; sensitive groups should stay indoors.' },
  { max: 300, level: 'Very Unhealthy', color: '#6a1b9a', advice: 'Avoid outdoor activity. Keep windows shut and run air purification.' },
  { max: Infinity, level: 'Hazardous', color: '#5d0f1d', advice: 'Health emergency conditions. Stay indoors with filtered air.' }
];

/**
 * Map an AQI value to its band.
 * @param {number} aqi
 * @returns {{level:string,color:string,advice:string}}
 */
function categorize(aqi) {
  if (typeof aqi !== 'number' || Number.isNaN(aqi) || aqi < 0) {
    return { level: 'Unknown', color: '#555555', advice: 'Air-quality data unavailable.' };
  }
  const band = AQI_BANDS.find((b) => aqi <= b.max);
  return { level: band.level, color: band.color, advice: band.advice };
}

/**
 * Find the cleanest upcoming hours (for scheduling outdoor time).
 * @param {{time:string,aqi:number}[]} hourly
 * @param {Date} now
 * @param {number} count
 */
function findCleanestWindows(hourly, now = new Date(), count = 3) {
  if (!Array.isArray(hourly)) return [];
  return hourly
    .filter((h) => typeof h.aqi === 'number' && new Date(h.time) >= new Date(now.getTime() - 3600_000))
    .sort((a, b) => a.aqi - b.aqi)
    .slice(0, count)
    .sort((a, b) => new Date(a.time) - new Date(b.time));
}

async function fetchJson(url, options, fetchImpl, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { ...options, signal: controller.signal });
    if (!res.ok) throw new Error(`Upstream ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fromOpenMeteo(lat, lon, fetchImpl) {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    current: 'us_aqi,pm2_5,pm10,nitrogen_dioxide,ozone,carbon_monoxide',
    hourly: 'us_aqi,pm2_5',
    forecast_days: '2',
    timezone: 'auto'
  });
  const data = await fetchJson(`${OPEN_METEO_URL}?${params}`, {}, fetchImpl);
  const c = data.current || {};
  const times = data.hourly?.time || [];
  const hourly = times.map((t, i) => ({
    time: t,
    aqi: data.hourly.us_aqi?.[i],
    pm25: data.hourly.pm2_5?.[i]
  }));
  return {
    source: 'Open-Meteo (CAMS)',
    aqi: Math.round(c.us_aqi),
    pollutants: {
      pm25: c.pm2_5 ?? null,
      pm10: c.pm10 ?? null,
      no2: c.nitrogen_dioxide ?? null,
      o3: c.ozone ?? null,
      co: c.carbon_monoxide ?? null
    },
    dominantPollutant: dominantOf(c),
    hourly,
    timezone: data.timezone || 'UTC'
  };
}

function dominantOf(c) {
  // Crude but transparent: ratio of each pollutant to its WHO 24h/8h guideline.
  const who = { pm2_5: 15, pm10: 45, nitrogen_dioxide: 25, ozone: 100 };
  let best = 'pm25';
  let bestRatio = -1;
  for (const [k, limit] of Object.entries(who)) {
    const r = (c[k] ?? 0) / limit;
    if (r > bestRatio) {
      bestRatio = r;
      best = { pm2_5: 'pm25', pm10: 'pm10', nitrogen_dioxide: 'no2', ozone: 'o3' }[k];
    }
  }
  return best;
}

async function fromGoogle(lat, lon, apiKey, fetchImpl) {
  const headers = { 'Content-Type': 'application/json' };
  const location = { latitude: lat, longitude: lon };
  const current = await fetchJson(
    `${GOOGLE_AQ_URL}?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        location,
        extraComputations: ['LOCAL_AQI', 'POLLUTANT_CONCENTRATION', 'DOMINANT_POLLUTANT_CONCENTRATION'],
        customLocalAqis: [{ regionCode: 'IN', aqi: 'usa_epa' }, { regionCode: 'US', aqi: 'usa_epa' }],
        universalAqi: false
      })
    },
    fetchImpl
  );
  const idx = (current.indexes || []).find((i) => i.code === 'usa_epa') || (current.indexes || [])[0] || {};
  const pol = Object.fromEntries((current.pollutants || []).map((p) => [p.code, p.concentration?.value ?? null]));

  let hourly = [];
  try {
    const start = new Date();
    const end = new Date(start.getTime() + 24 * 3600_000);
    const fc = await fetchJson(
      `${GOOGLE_AQ_FORECAST_URL}?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          location,
          period: { startTime: start.toISOString(), endTime: end.toISOString() },
          customLocalAqis: [{ regionCode: 'IN', aqi: 'usa_epa' }, { regionCode: 'US', aqi: 'usa_epa' }],
          universalAqi: false,
          extraComputations: ['LOCAL_AQI']
        })
      },
      fetchImpl
    );
    hourly = (fc.hourlyForecasts || []).map((h) => {
      const i = (h.indexes || []).find((x) => x.code === 'usa_epa') || (h.indexes || [])[0] || {};
      return { time: h.dateTime, aqi: i.aqi, pm25: null };
    });
  } catch {
    /* forecast is optional */
  }

  return {
    source: 'Google Air Quality API',
    aqi: idx.aqi,
    pollutants: {
      pm25: pol.pm25 ?? null,
      pm10: pol.pm10 ?? null,
      no2: pol.no2 ?? null,
      o3: pol.o3 ?? null,
      co: pol.co ?? null
    },
    dominantPollutant: idx.dominantPollutant || 'pm25',
    hourly,
    timezone: 'UTC'
  };
}

/**
 * Get normalised air quality for a coordinate.
 * @param {number} lat
 * @param {number} lon
 * @param {{googleApiKey?:string, fetchImpl?:Function}} [opts]
 */
async function getAirQuality(lat, lon, opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  let aq;
  if (opts.googleApiKey) {
    try {
      aq = await fromGoogle(lat, lon, opts.googleApiKey, fetchImpl);
    } catch (err) {
      console.warn('Google AQ failed, falling back to Open-Meteo:', err.message);
    }
  }
  if (!aq) aq = await fromOpenMeteo(lat, lon, fetchImpl);
  return {
    ...aq,
    category: categorize(aq.aqi),
    cleanestWindows: findCleanestWindows(aq.hourly)
  };
}

module.exports = { categorize, findCleanestWindows, getAirQuality, AQI_BANDS, dominantOf };
