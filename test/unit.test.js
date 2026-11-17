'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { categorize, findCleanestWindows, dominantOf } = require('../src/aqi');
const { inhaledDose, commuteSwitchImpact, suggestAlternativeMode, computeImpacts } = require('../src/impact');
const { validateProfile, validateCoords, validateQuestion, ValidationError } = require('../src/validate');
const { fallbackPlan, isValidPlan, buildContext } = require('../src/gemini');
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
