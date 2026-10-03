const DAY_MS = 24 * 60 * 60 * 1000;

function parseDay(isoDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) throw new Error(`bad date: ${isoDate}`);
  return new Date(isoDate);
}

function addBusinessDays(isoDate, days) {
  const d = parseDay(isoDate);
  let added = 0;
  while (added < days) {
    d.setTime(d.getTime() + DAY_MS);
    const weekday = d.getDay();
    if (weekday !== 0 && weekday !== 6) added++;
  }
  return d;
}

function formatDay(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function dueDate(isoDate, businessDays) {
  return formatDay(addBusinessDays(isoDate, businessDays));
}

module.exports = { dueDate, addBusinessDays, formatDay };
