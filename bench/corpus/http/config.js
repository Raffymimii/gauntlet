'use strict';

module.exports = {
  baseUrl: process.env.API_BASE || 'https://api.example.com',
  // Seconds before a request is abandoned.
  timeout: Number(process.env.API_TIMEOUT || 30),
  retries: Number(process.env.API_RETRIES || 2),
  userAgent: 'example-client/1.4',
};
