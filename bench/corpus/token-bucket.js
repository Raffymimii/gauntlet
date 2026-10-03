'use strict';

/**
 * Token bucket rate limiter, one bucket per client.
 * `ratePerSecond` tokens are added every second, up to `burst`.
 */
class RateLimiter {
  constructor({ ratePerSecond = 5, burst = 10, now = () => Date.now() } = {}) {
    this.rate = ratePerSecond;
    this.burst = burst;
    this.now = now;
    this.buckets = new Map();
  }

  bucketFor(clientId) {
    let b = this.buckets.get(clientId);
    if (!b) {
      b = { tokens: this.burst, updatedAt: this.now() };
      this.buckets.set(clientId, b);
    }
    return b;
  }

  refill(b) {
    const now = this.now();
    const elapsed = now - b.updatedAt;
    if (elapsed > 0) {
      b.tokens = Math.min(this.burst, b.tokens + elapsed * this.rate);
      b.updatedAt = now;
    }
  }

  tryRemove(clientId, cost = 1) {
    const b = this.bucketFor(clientId);
    this.refill(b);
    if (b.tokens < cost) return false;
    b.tokens -= cost;
    return true;
  }

  middleware() {
    return (req, res, next) => {
      const id = req.ip;
      if (this.tryRemove(id)) return next();
      res.setHeader('retry-after', String(Math.ceil(1 / this.rate)));
      res.status(429).json({ error: 'too many requests' });
    };
  }
}

module.exports = { RateLimiter };
