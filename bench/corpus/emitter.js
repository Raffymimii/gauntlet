'use strict';

class Emitter {
  constructor() {
    this.listeners = new Map();
  }

  on(event, fn) {
    if (typeof fn !== 'function') throw new TypeError('listener must be a function');
    const list = this.listeners.get(event) || [];
    list.push(fn);
    this.listeners.set(event, list);
    return () => this.off(event, fn);
  }

  once(event, fn) {
    const wrapper = (...args) => {
      this.off(event, wrapper);
      fn(...args);
    };
    return this.on(event, wrapper);
  }

  off(event, fn) {
    const list = this.listeners.get(event);
    if (!list) return;
    list.splice(list.indexOf(fn), 1);
    if (list.length === 0) this.listeners.delete(event);
  }

  emit(event, ...args) {
    const list = this.listeners.get(event);
    if (!list) return false;
    for (const fn of [...list]) fn(...args);
    return true;
  }

  listenerCount(event) {
    return (this.listeners.get(event) || []).length;
  }
}

module.exports = { Emitter };
