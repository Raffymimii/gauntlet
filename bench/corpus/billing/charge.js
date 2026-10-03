'use strict';

const { createCharge } = require('./gateway');

const MIN_ORDER_CENTS = 50;

function orderTotalCents(order) {
  return order.lines.reduce((sum, line) => sum + line.unitPriceCents * line.quantity, 0);
}

async function chargeOrder(order, customer) {
  const totalCents = orderTotalCents(order);
  if (totalCents < MIN_ORDER_CENTS) {
    throw new Error(`order total ${totalCents} is below the minimum charge`);
  }
  const charge = await createCharge({
    customerId: customer.gatewayId,
    amount: totalCents,
    currency: order.currency || 'EUR',
    description: `Order ${order.id}`,
    idempotencyKey: `order-${order.id}`,
  });
  return { chargeId: charge.id, amountCents: totalCents };
}

module.exports = { chargeOrder, orderTotalCents };
