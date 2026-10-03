const TAX_RATE = 0.22;

function toCents(amount) {
  return Math.round(Number(amount) * 100);
}

/**
 * @param {number} priceCents  unit price in cents
 * @param {number} quantity
 * @param {number} percentOff  discount as a percentage, 0 to 100
 */
function lineTotal(priceCents, quantity, percentOff = 0) {
  if (quantity <= 0) return 0;
  const pct = Math.min(Math.max(percentOff, 0), 100);
  const discounted = priceCents * (1 - pct);
  return Math.round(discounted * quantity);
}

function orderTotal(lines) {
  const subtotal = lines.reduce((sum, l) => sum + lineTotal(l.priceCents, l.quantity, l.percentOff), 0);
  const tax = Math.round(subtotal * TAX_RATE);
  return { subtotal, tax, total: subtotal + tax };
}

module.exports = { toCents, lineTotal, orderTotal };
