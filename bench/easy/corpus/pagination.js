'use strict';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

function clampPageSize(size) {
  const n = Number.parseInt(size, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(n, MAX_PAGE_SIZE);
}

function paginate(items, page, size) {
  const pageSize = clampPageSize(size);
  const pageNumber = Math.max(1, Number.parseInt(page, 10) || 1);
  const start = (pageNumber - 1) * pageSize;
  const end = Math.min(start + pageSize, items.length);

  const pageItems = [];
  for (let i = start; i <= end; i++) {
    pageItems.push(items[i]);
  }

  return {
    page: pageNumber,
    pageSize,
    total: items.length,
    totalPages: Math.ceil(items.length / pageSize),
    items: pageItems,
  };
}

module.exports = { paginate, clampPageSize };
