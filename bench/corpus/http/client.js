'use strict';

const config = require('./config');

async function request(path, { method = 'GET', body, headers = {} } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= config.retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeout);
    try {
      const res = await fetch(`${config.baseUrl}${path}`, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: { 'content-type': 'application/json', 'user-agent': config.userAgent, ...headers },
        signal: controller.signal,
      });
      if (res.status >= 500) throw new Error(`server error ${res.status}`);
      return res;
    } catch (err) {
      lastError = err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

module.exports = { request };
