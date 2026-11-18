'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { categorize, findCleanestWindows, dominantOf } = require('../src/aqi');
const { inhaledDose, commuteSwitchImpact, suggestAlternativeMode, computeImpacts } = require('../src/impact');
const { validateProfile, validateCoords, validateQuestion, ValidationError } = require('../src/validate');
const { fallbackPlan, isValidPlan, buildContext, stripFences, callGemini, isRetryable } = require('../src/gemini');
const { TTLCache, coordKey } = require('../src/cache');

const sampleAq = {
  source: 'test',
  aqi: 280,
  pollutants: { pm25: 180, pm10: 300, no2: 60, o3: 20, co: 1000 },
  dominantPollutant: 'pm25',
  hourly: [
    { time: '2099-01-01T06:00', aqi: 320 },
    { time: '2099-01-01T14:00', aqi: 190 },
    { time: '2099-01-01T22:00', aqi: 300 }
  ],
  category: categorize(280),
  cleanestWindows: [{ time: '2099-01-01T14:00', aqi: 190 }],
  timezone: 'Asia/Kolkata'
};

describe('categorize', () => {
  test('maps AQI to EPA bands at boundaries', () => {
    assert.equal(categorize(0).level, 'Good');
    assert.equal(categorize(50).level, 'Good');
    assert.equal(categorize(51).level, 'Moderate');
    assert.equal(categorize(151).level, 'Unhealthy');
    assert.equal(categorize(250).level, 'Very Unhealthy');
    assert.equal(categorize(301).level, 'Hazardous');
  });
  test('handles invalid input', () => {
    assert.equal(categorize(NaN).level, 'Unknown');
    assert.equal(categorize(-1).level, 'Unknown');
    assert.equal(categorize('x').level, 'Unknown');
  });
});

describe('findCleanestWindows', () => {
  test('returns lowest AQI hours in chronological order', () => {
    const now = new Date('2099-01-01T00:00');
    const w = findCleanestWindows(sampleAq.hourly, now, 2);
    assert.deepEqual(w.map((x) => x.aqi), [190, 300]);
  });
  test('ignores past hours and non-array input', () => {
    assert.deepEqual(findCleanestWindows(null), []);
    assert.equal(findCleanestWindows(sampleAq.hourly, new Date('2100-01-01')).length, 0);
  });
});

describe('dominantOf', () => {
  test('picks pollutant furthest above WHO guideline', () => {
    assert.equal(dominantOf({ pm2_5: 150, pm10: 100, nitrogen_dioxide: 20, ozone: 30 }), 'pm25');
    assert.equal(dominantOf({ pm2_5: 5, pm10: 10, nitrogen_dioxide: 200, ozone: 30 }), 'no2');
  });
});

describe('impact engine', () => {
  test('inhaled dose scales with concentration, time and mask', () => {
    assert.equal(inhaledDose(100, 1, 'light', 'none'), 100);
    assert.equal(Math.round(inhaledDose(100, 1, 'light', 'n95_fitted')), 10);
    assert.equal(inhaledDose(100, 2, 'vigorous'), 640);
  });

  test('commute switch computes monthly savings', () => {
    const s = commuteSwitchImpact('car_petrol', 'metro', 10, 22);
    assert.equal(s.kmPerMonth, 440);
    assert.equal(s.co2KgPerMonth, 61.6);
    assert.ok(s.pm25GramsPerMonth > 0);
  });

  test('never reports negative savings', () => {
    assert.equal(commuteSwitchImpact('metro', 'car_diesel', 10).co2KgPerMonth, 0);
  });

  test('suggests realistic alternatives by distance', () => {
    assert.equal(suggestAlternativeMode('car_petrol', 1.5), 'walk');
    assert.equal(suggestAlternativeMode('two_wheeler', 5), 'cycle');
    assert.equal(suggestAlternativeMode('car_diesel', 15), 'metro');
    assert.equal(suggestAlternativeMode('metro', 15), null);
  });

  test('computeImpacts produces quantified, categorised actions', () => {
    const profile = validateProfile({ commuteMode: 'car_diesel', commuteKm: 12, cookingFuel: 'biomass' });
    const impacts = computeImpacts(profile, sampleAq);
    const ids = impacts.map((i) => i.id);
    assert.ok(ids.includes('mask'));
    assert.ok(ids.includes('purifier'));
    assert.ok(ids.includes('commute_switch'));
    assert.ok(ids.includes('cooking'));
    for (const i of impacts) {
      assert.equal(typeof i.metric, 'string');
      assert.ok(['exposure', 'indoor', 'emissions'].includes(i.category));
    }
  });

  test('wfh user gets no commute impacts', () => {
    const impacts = computeImpacts(validateProfile({ commuteMode: 'wfh' }), sampleAq);
    assert.ok(!impacts.some((i) => i.id === 'mask' || i.id === 'commute_switch'));
  });
});

describe('validation', () => {
  test('applies defaults and drops unknown keys', () => {
    const p = validateProfile({ evil: '<script>' });
    assert.equal(p.householdSize, 3);
    assert.equal(p.evil, undefined);
  });
  test('rejects bad enums and ranges', () => {
    assert.throws(() => validateProfile({ commuteMode: 'rocket' }), ValidationError);
    assert.throws(() => validateProfile({ commuteKm: -5 }), ValidationError);
    assert.throws(() => validateProfile({ sensitiveGroups: ['aliens'] }), ValidationError);
    assert.throws(() => validateProfile([]), ValidationError);
  });
  test('validates coordinates', () => {
    assert.deepEqual(validateCoords({ lat: '28.6', lon: '77.2' }), { lat: 28.6, lon: 77.2 });
    assert.throws(() => validateCoords({ lat: 100, lon: 0 }), ValidationError);
    assert.throws(() => validateCoords({}), ValidationError);
  });
  test('sanitises questions', () => {
    assert.equal(validateQuestion('  hi there\u0000 '), 'hi there');
    assert.throws(() => validateQuestion('a'.repeat(501)), ValidationError);
    assert.throws(() => validateQuestion(42), ValidationError);
  });
});

describe('gemini helpers', () => {
  const profile = validateProfile({ sensitiveGroups: ['children', 'asthma'] });
  const impacts = computeImpacts(profile, sampleAq);

  test('fallback plan is valid and mentions sensitive groups', () => {
    const plan = fallbackPlan(profile, sampleAq, impacts);
    assert.ok(isValidPlan(plan));
    assert.match(plan.healthAlert, /children/);
    assert.equal(plan.generatedBy, 'rules');
  });

  test('context grounds the model with live numbers', () => {
    const ctx = buildContext(profile, sampleAq, impacts, 'Delhi');
    assert.match(ctx, /US AQI 280/);
    assert.match(ctx, /PM2\.5 180/);
    assert.match(ctx, /Delhi/);
  });

  test('fallback never says exercise outdoors when even the best hour is unhealthy', () => {
    const plan = fallbackPlan(profile, sampleAq, impacts);
    const step = plan.routine.find((r) => r.time === 'Exercise');
    assert.ok(step);
    assert.match(step.action, /indoors/);
  });

  test('fallback only mentions running a purifier if the household has one', () => {
    const night = (p) => fallbackPlan(p, sampleAq, impacts).routine.find((r) => r.time === 'Night').action;
    assert.doesNotMatch(night(profile), /Run the purifier/);
    assert.match(night({ ...profile, hasPurifier: true }), /Run the purifier/);
  });

  test('stripFences removes markdown code fences', () => {
    assert.equal(stripFences('```json\n{"a":1}\n```'), '{"a":1}');
    assert.equal(stripFences('{"a":1}'), '{"a":1}');
  });

  test('isValidPlan rejects malformed output', () => {
    assert.equal(isValidPlan({ headline: 'x' }), false);
    assert.equal(isValidPlan(null), false);
  });
});

describe('cache', () => {
  test('stores, expires and bounds entries', async () => {
    const c = new TTLCache({ ttlMs: 20, max: 2 });
    c.set('a', 1); c.set('b', 2); c.set('c', 3);
    assert.equal(c.get('a'), undefined);
    assert.equal(c.get('c'), 3);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(c.get('c'), undefined);
  });
  test('coordKey rounds to ~1km', () => {
    assert.equal(coordKey(28.61391, 77.20902), '28.61,77.21');
  });
});

describe('Gemini failover', () => {
  const ok = (text) => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }) });
  const fail = (status) => ({ ok: false, status, text: async () => '{"error":"busy"}' });
  const quiet = (fn) => async () => {
    const warn = console.warn;
    console.warn = () => {};
    try { await fn(); } finally { console.warn = warn; }
  };

  test('falls over to the next model when the primary is overloaded (503)', quiet(async () => {
    const seen = [];
    const fetchImpl = async (url) => {
      seen.push(url);
      return url.includes('model-a') ? fail(503) : ok('hello');
    };
    const text = await callGemini({ apiKey: 'k', model: ['model-a', 'model-b'], contents: [], fetchImpl, backoffMs: 1 });
    assert.equal(text, 'hello');
    assert.equal(seen.length, 2);
  }));

  test('does not retry on auth errors', quiet(async () => {
    let calls = 0;
    const fetchImpl = async () => { calls++; return fail(401); };
    await assert.rejects(callGemini({ apiKey: 'k', model: ['a', 'b'], contents: [], fetchImpl, backoffMs: 1 }), /401/);
    assert.equal(calls, 1);
  }));

  test('classifies retryable errors', () => {
    assert.equal(isRetryable({ status: 503 }), true);
    assert.equal(isRetryable({ status: 429 }), true);
    assert.equal(isRetryable({ status: 400 }), false);
    assert.equal(isRetryable(new Error('ETIMEDOUT')), true);
  });
});
