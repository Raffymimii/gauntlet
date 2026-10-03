'use strict';

class Semaphore {
  constructor(permits) {
    this.permits = permits;
    this.waiting = [];
  }

  async acquire() {
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    await new Promise((resolve) => this.waiting.push(resolve));
  }

  release() {
    const next = this.waiting.shift();
    if (next) next();
    else this.permits++;
  }
}

const thumbnails = new Map();
const renderSlots = new Semaphore(4);

async function renderThumbnail(image, { width = 320, render }) {
  await renderSlots.acquire();
  const key = `${image.id}:${width}`;
  if (thumbnails.has(key)) {
    return thumbnails.get(key);
  }
  try {
    const result = await render(image, width);
    thumbnails.set(key, result);
    return result;
  } finally {
    renderSlots.release();
  }
}

async function renderAll(images, options) {
  return Promise.all(images.map((image) => renderThumbnail(image, options)));
}

module.exports = { Semaphore, renderThumbnail, renderAll };
