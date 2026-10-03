interface Entry<V> {
  value: V;
  expires: number;
}

export class TtlCache<K, V> {
  private entries = new Map<K, Entry<V>>();

  constructor(private readonly ttlMs: number, private readonly maxEntries = 1000) {}

  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expires > Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: K, value: V): void {
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value as K;
      this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expires: Date.now() + this.ttlMs });
  }

  get size(): number {
    return this.entries.size;
  }
}
