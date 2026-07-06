class MessageDeduplicator {
  constructor() {
    this.store = new Map();
    setInterval(() => this.cleanup(), 60_000).unref();
  }

  isDuplicate(key, ttlMs = 10 * 60 * 1000) {
    const now = Date.now();
    const expiresAt = this.store.get(key);
    if (expiresAt && expiresAt > now) return true;
    this.store.set(key, now + ttlMs);
    return false;
  }

  cleanup() {
    const now = Date.now();
    for (const [key, expiresAt] of this.store.entries()) {
      if (expiresAt <= now) this.store.delete(key);
    }
  }
}

export default new MessageDeduplicator();
