'use strict';

const MAX_LENGTH = 80;

function slugify(title) {
  return String(title ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_LENGTH)
    .replace(/-+$/g, '');
}

/**
 * A slug for `title` that is not in `taken`, never longer than MAX_LENGTH. The caller owns
 * `taken` and adds the result to it when it actually stores the slug.
 */
function uniqueSlug(title, taken) {
  const base = slugify(title) || 'item';
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    if (suffix.length >= MAX_LENGTH) throw new RangeError('no free slug left for this title');
    const candidate = `${base.slice(0, MAX_LENGTH - suffix.length).replace(/-+$/g, '')}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

module.exports = { slugify, uniqueSlug, MAX_LENGTH };
