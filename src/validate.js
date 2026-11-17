'use strict';

const COMMUTE_MODES = [
  'car_petrol', 'car_diesel', 'car_cng', 'two_wheeler', 'auto_rickshaw',
  'bus', 'metro', 'ev', 'cycle', 'walk', 'wfh'
];
const SENSITIVE_GROUPS = ['children', 'elderly', 'asthma', 'heart', 'pregnant'];
const COOKING_FUELS = ['lpg', 'induction', 'png', 'biomass', 'kerosene'];
const LANGUAGES = ['en', 'hi'];

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
  }
}

function num(value, name, min, max, fallback) {
  if (value === undefined || value === null || value === '') {
    if (fallback !== undefined) return fallback;
    throw new ValidationError(`${name} is required`);
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new ValidationError(`${name} must be a number between ${min} and ${max}`);
  }
  return n;
}

function oneOf(value, name, allowed, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (!allowed.includes(value)) throw new ValidationError(`${name} must be one of: ${allowed.join(', ')}`);
  return value;
}

/** Validate coordinates. */
function validateCoords(body) {
  return {
    lat: num(body?.lat, 'lat', -90, 90),
    lon: num(body?.lon, 'lon', -180, 180)
  };
}

/** Validate and normalise the lifestyle profile. Unknown keys are dropped. */
function validateProfile(p = {}) {
  if (typeof p !== 'object' || Array.isArray(p)) throw new ValidationError('profile must be an object');
  const groups = Array.isArray(p.sensitiveGroups) ? p.sensitiveGroups : [];
  if (groups.length > SENSITIVE_GROUPS.length) throw new ValidationError('too many sensitiveGroups');
  for (const g of groups) {
    if (!SENSITIVE_GROUPS.includes(g)) throw new ValidationError(`unknown sensitive group: ${String(g).slice(0, 20)}`);
  }
  return {
    householdSize: Math.round(num(p.householdSize, 'householdSize', 1, 20, 3)),
    sensitiveGroups: [...new Set(groups)],
    commuteMode: oneOf(p.commuteMode, 'commuteMode', COMMUTE_MODES, 'two_wheeler'),
    commuteKm: num(p.commuteKm, 'commuteKm', 0, 200, 8),
    commuteMinutes: Math.round(num(p.commuteMinutes, 'commuteMinutes', 0, 300, 40)),
    outdoorExerciseMinutes: Math.round(num(p.outdoorExerciseMinutes, 'outdoorExerciseMinutes', 0, 300, 30)),
    hasPurifier: p.hasPurifier === true || p.hasPurifier === 'true',
    cookingFuel: oneOf(p.cookingFuel, 'cookingFuel', COOKING_FUELS, 'lpg'),
    language: oneOf(p.language, 'language', LANGUAGES, 'en')
  };
}

/** Free-text question: trimmed, length-capped, control chars stripped. */
function validateQuestion(q) {
  if (typeof q !== 'string') throw new ValidationError('question must be a string');
  // eslint-disable-next-line no-control-regex
  const clean = q.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').trim();
  if (clean.length < 3) throw new ValidationError('question is too short');
  if (clean.length > 500) throw new ValidationError('question must be under 500 characters');
  return clean;
}

function validatePlaceQuery(q) {
  if (typeof q !== 'string') throw new ValidationError('q is required');
  const clean = q.trim();
  if (clean.length < 2 || clean.length > 100) throw new ValidationError('q must be 2-100 characters');
  return clean;
}

module.exports = {
  validateCoords,
  validateProfile,
  validateQuestion,
  validatePlaceQuery,
  ValidationError,
  COMMUTE_MODES,
  SENSITIVE_GROUPS,
  COOKING_FUELS
};
