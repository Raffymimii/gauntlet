'use strict';

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

function parse(version) {
  const m = SEMVER.exec(String(version).trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || null, raw: version };
}

function isStable(version) {
  const v = parse(version);
  return v !== null && v.pre === null;
}

function latestStable(versions) {
  const stable = versions.filter(isStable).map((v) => String(v).trim().replace(/^v/, ''));
  if (stable.length === 0) return null;
  stable.sort();
  return stable[stable.length - 1];
}

function needsUpdate(current, available) {
  const latest = latestStable(available);
  if (!latest) return false;
  const a = parse(current);
  const b = parse(latest);
  if (!a || !b) return false;
  if (b.major !== a.major) return b.major > a.major;
  if (b.minor !== a.minor) return b.minor > a.minor;
  return b.patch > a.patch;
}

module.exports = { parse, isStable, latestStable, needsUpdate };
