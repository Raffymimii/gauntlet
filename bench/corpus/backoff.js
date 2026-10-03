'use strict';

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calls `fn` until it succeeds, it fails with a non-retryable error, or `maxAttempts`
 * attempts have been made. Waits base * 2^n ms between attempts, capped, with full jitter.
 */
async function withBackoff(fn, { maxAttempts = 4, baseMs = 200, capMs = 5000, random = Math.random } = {}) {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new RangeError('maxAttempts must be a positive integer');
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      const retryable = RETRYABLE.has(err && err.status);
      if (!retryable || attempt >= maxAttempts) throw err;
      const ceiling = Math.min(capMs, baseMs * 2 ** (attempt - 1));
      await sleep(Math.floor(random() * ceiling));
    }
  }
}

module.exports = { withBackoff, RETRYABLE };
