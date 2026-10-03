'use strict';

/**
 * Least-recently-used cache with an optional size budget.
 * Entries are kept in a Map, whose iteration order is insertion order: the first key is
 * the least recently used one.
 */
class LruCache {
  constructor({ maxEntries = 500, maxBytes = Infinity, sizeOf = () => 1 } = {}) {
    if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
      throw new RangeError('maxEntries must be a positive integer');
    }
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.sizeOf = sizeOf;
    this.map = new Map();
    this.bytes = 0;
    this.hits = 0;
    this.misses = 0;
  }

  has(key) {
    return this.map.has(key);
  }

  get(key) {
    const entry = this.map.get(key);
    if (entry === undefined) {
      this.misses++;
      return undefined;
    }
    this.hits++;
    return entry.value;
  }

  set(key, value) {
    const size = this.sizeOf(value);
    if (size > this.maxBytes) return false;
    const existing = this.map.get(key);
    if (existing !== undefined) {
      this.bytes -= existing.size;
      this.map.delete(key);
    }
    this.map.set(key, { value, size });
    this.bytes += size;
    this.evict();
    return true;
  }

  delete(key) {
    const entry = this.map.get(key);
    if (entry === undefined) return false;
    this.bytes -= entry.size;
    return this.map.delete(key);
  }

  evict() {
    while (this.map.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldestKey = this.map.keys().next().value;
      this.delete(oldestKey);
    }
  }

  stats() {
    const total = this.hits + this.misses;
    return {
      entries: this.map.size,
      bytes: this.bytes,
      hitRate: total === 0 ? 0 : this.hits / total,
    };
  }
}

module.exports = { LruCache };
