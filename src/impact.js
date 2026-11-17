'use strict';

/**
 * Deterministic impact engine.
 * The LLM writes the advice; these numbers are computed in code so the
 * "direct impact" of each choice is transparent, reproducible and never hallucinated.
 */

/** kg CO2e per passenger-km (approximate, India/urban averages; documented in README). */
const EMISSION_FACTORS = {
  car_petrol: 0.17,
  car_diesel: 0.17,
  car_cng: 0.12,
  two_wheeler: 0.06,
  auto_rickshaw: 0.08,
  bus: 0.05,
  metro: 0.03,
  ev: 0.08,
  cycle: 0,
  walk: 0,
  wfh: 0
};

/** Tailpipe PM2.5 in grams per vehicle-km (order-of-magnitude urban estimates). */
const PM25_FACTORS = {
  car_petrol: 0.004,
  car_diesel: 0.05,
  car_cng: 0.002,
  two_wheeler: 0.02,
  auto_rickshaw: 0.03,
  bus: 0.01,
  metro: 0,
  ev: 0,
  cycle: 0,
  walk: 0,
  wfh: 0
};

/** Breathing rates in m³/hour (US EPA Exposure Factors Handbook, adult). */
const BREATHING_RATE = { rest: 0.4, light: 1.0, moderate: 1.6, vigorous: 3.2 };

/** Indoor/outdoor PM2.5 ratios. */
const INDOOR_RATIO = {
  windows_open: 0.9,
  windows_closed: 0.6,
  closed_with_purifier: 0.25
};

const MASK_EFFICIENCY = { none: 0, cloth: 0.2, surgical: 0.4, n95_fitted: 0.9 };

const WORK_DAYS_PER_MONTH = 22;

const round = (n, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

/**
 * PM2.5 inhaled (µg) = concentration (µg/m³) × breathing rate (m³/h) × hours × (1 − mask efficiency)
 */
function inhaledDose(pm25, hours, activity = 'light', mask = 'none') {
  const rate = BREATHING_RATE[activity] ?? BREATHING_RATE.light;
  const eff = MASK_EFFICIENCY[mask] ?? 0;
  return Math.max(0, pm25 * rate * hours * (1 - eff));
}

/** Monthly CO2 + PM2.5 saved by switching commute mode (round trip). */
function commuteSwitchImpact(fromMode, toMode, oneWayKm, daysPerMonth = WORK_DAYS_PER_MONTH) {
  const km = oneWayKm * 2 * daysPerMonth;
  const co2 = (EMISSION_FACTORS[fromMode] ?? 0) - (EMISSION_FACTORS[toMode] ?? 0);
  const pm = (PM25_FACTORS[fromMode] ?? 0) - (PM25_FACTORS[toMode] ?? 0);
  return {
    co2KgPerMonth: round(Math.max(0, co2 * km)),
    pm25GramsPerMonth: round(Math.max(0, pm * km), 2),
    kmPerMonth: km
  };
}

/** Pick the most realistic low-emission alternative for a commute distance. */
function suggestAlternativeMode(mode, oneWayKm) {
  if (['walk', 'cycle', 'wfh', 'metro'].includes(mode)) return null;
  if (oneWayKm <= 2) return 'walk';
  if (oneWayKm <= 6) return 'cycle';
  return 'metro';
}

/**
 * Build the list of quantified impacts for a profile + live air-quality reading.
 * @param {object} profile validated profile
 * @param {{aqi:number,pollutants:{pm25:number|null}}} aq
 */
function computeImpacts(profile, aq) {
  const pm25 = aq.pollutants?.pm25 ?? Math.max(5, aq.aqi * 0.45);
  const impacts = [];

  // 1. Mask on commute
  const commuteHours = (profile.commuteMinutes * 2) / 60;
  if (profile.commuteMode !== 'wfh' && commuteHours > 0) {
    const activity = ['cycle', 'walk'].includes(profile.commuteMode) ? 'moderate' : 'light';
    const before = inhaledDose(pm25, commuteHours, activity, 'none');
    const after = inhaledDose(pm25, commuteHours, activity, 'n95_fitted');
    impacts.push({
      id: 'mask',
      title: 'Wear a well-fitted N95 during your commute',
      metric: `${round(before - after, 0)} µg less PM2.5 inhaled per day`,
      percent: round(((before - after) / (before || 1)) * 100, 0),
      category: 'exposure'
    });
  }

  // 2. Indoor purification
  const indoorHours = 14;
  const currentRatio = profile.hasPurifier ? INDOOR_RATIO.closed_with_purifier : INDOOR_RATIO.windows_open;
  if (!profile.hasPurifier) {
    const before = inhaledDose(pm25 * INDOOR_RATIO.windows_open, indoorHours, 'rest');
    const after = inhaledDose(pm25 * INDOOR_RATIO.closed_with_purifier, indoorHours, 'rest');
    impacts.push({
      id: 'purifier',
      title: 'Close windows during peaks and run a HEPA purifier (or DIY box-fan filter) in the bedroom',
      metric: `${round(before - after, 0)} µg less PM2.5 inhaled per person per day at home`,
      percent: round(((before - after) / (before || 1)) * 100, 0),
      category: 'indoor'
    });
  } else {
    impacts.push({
      id: 'purifier_ok',
      title: 'Keep your purifier on high in the room you sleep in',
      metric: `Indoor PM2.5 ≈ ${round(pm25 * currentRatio, 0)} µg/m³ vs ${round(pm25, 0)} outdoors`,
      percent: round((1 - currentRatio) * 100, 0),
      category: 'indoor'
    });
  }

  // 3. Shift exercise to cleanest hour
  if (profile.outdoorExerciseMinutes > 0) {
    const windows = Array.isArray(aq.hourly) ? aq.hourly.filter((h) => typeof h.aqi === 'number') : [];
    const best = windows.length ? Math.min(...windows.map((h) => h.aqi)) : aq.aqi;
    const ratio = aq.aqi > 0 ? Math.max(0, (aq.aqi - best) / aq.aqi) : 0;
    const hrs = profile.outdoorExerciseMinutes / 60;
    const now = inhaledDose(pm25, hrs, 'vigorous');
    impacts.push({
      id: 'exercise_timing',
      title: ratio > 0.1 ? 'Move outdoor exercise to the cleanest hour today' : 'Move vigorous exercise indoors today',
      metric:
        ratio > 0.1
          ? `≈ ${round(now * ratio, 0)} µg less PM2.5 inhaled (${round(ratio * 100, 0)}% cleaner air)`
          : `≈ ${round(now * (1 - INDOOR_RATIO.closed_with_purifier), 0)} µg less PM2.5 inhaled indoors`,
      percent: round((ratio > 0.1 ? ratio : 1 - INDOOR_RATIO.closed_with_purifier) * 100, 0),
      category: 'exposure'
    });
  }

  // 4. Commute mode switch (emissions you avoid creating)
  const alt = suggestAlternativeMode(profile.commuteMode, profile.commuteKm);
  if (alt && profile.commuteKm > 0) {
    const s = commuteSwitchImpact(profile.commuteMode, alt, profile.commuteKm);
    if (s.co2KgPerMonth > 0) {
      impacts.push({
        id: 'commute_switch',
        title: `Switch from ${label(profile.commuteMode)} to ${label(alt)} for your ${profile.commuteKm} km commute`,
        metric: `${s.co2KgPerMonth} kg CO₂ and ${s.pm25GramsPerMonth} g tailpipe PM2.5 avoided per month`,
        percent: 100,
        category: 'emissions',
        alternative: alt
      });
    }
  }

  // 5. Cooking fuel
  if (profile.cookingFuel === 'biomass' || profile.cookingFuel === 'kerosene') {
    impacts.push({
      id: 'cooking',
      title: 'Switch to LPG or induction cooking',
      metric: 'Cuts kitchen PM2.5 by up to ~90% vs solid fuel (WHO household-air estimates)',
      percent: 90,
      category: 'indoor'
    });
  }

  // 6. Waste burning
  impacts.push({
    id: 'no_burning',
    title: 'Never burn leaves or waste — compost or hand it to municipal collection',
    metric: 'Open burning of 1 kg dry waste releases ≈ 8 g PM2.5',
    percent: null,
    category: 'emissions'
  });

  return impacts;
}

function label(mode) {
  return {
    car_petrol: 'petrol car',
    car_diesel: 'diesel car',
    car_cng: 'CNG car',
    two_wheeler: 'two-wheeler',
    auto_rickshaw: 'auto-rickshaw',
    bus: 'bus',
    metro: 'metro',
    ev: 'EV',
    cycle: 'cycle',
    walk: 'walking',
    wfh: 'working from home'
  }[mode] || mode;
}

module.exports = {
  computeImpacts,
  inhaledDose,
  commuteSwitchImpact,
  suggestAlternativeMode,
  EMISSION_FACTORS,
  PM25_FACTORS,
  label
};
