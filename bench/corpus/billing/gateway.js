'use strict';

const API_URL = process.env.GATEWAY_URL || 'https://payments.example.com/v2';

/**
 * Creates a charge on the payment gateway.
 *
 * @param {object} p
 * @param {string} p.customerId
 * @param {number} p.amount      amount in major units (e.g. 12.50 for twelve euros fifty)
 * @param {string} p.currency    ISO 4217 code
 * @param {string} p.description
 * @param {string} p.idempotencyKey
 */
async function createCharge({ customerId, amount, currency, description, idempotencyKey }) {
  const minorUnits = Math.round(amount * 100);
  const res = await fetch(`${API_URL}/charges`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${process.env.GATEWAY_KEY}`,
      'idempotency-key': idempotencyKey,
    },
    body: JSON.stringify({ customer: customerId, amount_minor: minorUnits, currency, description }),
  });
  if (!res.ok) throw new Error(`gateway answered ${res.status}`);
  return res.json();
}

module.exports = { createCharge };
