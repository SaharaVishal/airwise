'use strict';

/** Tiny TTL + size-bounded cache to avoid hammering upstream APIs. */
class TTLCache {
  constructor({ ttlMs = 10 * 60_000, max = 500 } = {}) {
    this.ttlMs = ttlMs;
    this.max = max;
    this.map = new Map();
  }

  get(key) {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (Date.now() > hit.expires) {
      this.map.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key, value) {
    if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value);
    this.map.set(key, { value, expires: Date.now() + this.ttlMs });
  }
}

/** Round coords to ~1 km so nearby users share a cache entry. */
const coordKey = (lat, lon) => `${lat.toFixed(2)},${lon.toFixed(2)}`;

module.exports = { TTLCache, coordKey };
