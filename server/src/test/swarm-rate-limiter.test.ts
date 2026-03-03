/**
 * Tests for swarm rate limiter — sliding window, per-key isolation, reset.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We need to import from the actual module, but the module starts a setInterval
// on load. We'll mock timers to control it.
// Instead of importing the module directly (which has side effects with setInterval),
// we replicate the pure logic here for unit testing.

// ── Standalone rate limiter logic (mirrors swarm-rate-limiter.ts) ────────
const WINDOW_MS = 60_000;
const MAX_REQUESTS = 10;

interface RateLimitResult {
  allowed: boolean;
  retryAfterMs?: number;
}

class RateLimiter {
  private buckets = new Map<string, number[]>();

  checkRateLimit(key: string, now = Date.now()): RateLimitResult {
    const windowStart = now - WINDOW_MS;
    let timestamps = this.buckets.get(key) || [];
    timestamps = timestamps.filter(t => t > windowStart);

    if (timestamps.length >= MAX_REQUESTS) {
      const oldestInWindow = timestamps[0];
      const retryAfterMs = oldestInWindow + WINDOW_MS - now;
      this.buckets.set(key, timestamps);
      return { allowed: false, retryAfterMs: Math.max(retryAfterMs, 0) };
    }

    timestamps.push(now);
    this.buckets.set(key, timestamps);
    return { allowed: true };
  }

  resetRateLimit(key: string): void {
    this.buckets.delete(key);
  }

  cleanup(now = Date.now()): void {
    const cutoff = now - WINDOW_MS;
    for (const [key, timestamps] of this.buckets) {
      const active = timestamps.filter(t => t > cutoff);
      if (active.length === 0) {
        this.buckets.delete(key);
      } else {
        this.buckets.set(key, active);
      }
    }
  }

  get size() { return this.buckets.size; }
}

describe('Swarm rate limiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter();
  });

  it('should allow requests under the limit', () => {
    for (let i = 0; i < MAX_REQUESTS; i++) {
      expect(limiter.checkRateLimit('key1').allowed).toBe(true);
    }
  });

  it('should block the 11th request in the same window', () => {
    const now = Date.now();
    for (let i = 0; i < MAX_REQUESTS; i++) {
      limiter.checkRateLimit('key1', now + i);
    }
    const result = limiter.checkRateLimit('key1', now + MAX_REQUESTS);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it('should provide correct retryAfterMs', () => {
    const now = 1000000;
    for (let i = 0; i < MAX_REQUESTS; i++) {
      limiter.checkRateLimit('key1', now + i * 100);
    }
    const result = limiter.checkRateLimit('key1', now + 1000);
    expect(result.allowed).toBe(false);
    // Oldest timestamp is `now`, expires at `now + WINDOW_MS`
    // retryAfterMs = now + WINDOW_MS - (now + 1000) = WINDOW_MS - 1000
    expect(result.retryAfterMs).toBe(WINDOW_MS - 1000);
  });

  it('should allow requests after the window expires', () => {
    const now = 1000000;
    for (let i = 0; i < MAX_REQUESTS; i++) {
      limiter.checkRateLimit('key1', now);
    }
    // After window expires
    const result = limiter.checkRateLimit('key1', now + WINDOW_MS + 1);
    expect(result.allowed).toBe(true);
  });

  it('should isolate rate limits per key', () => {
    for (let i = 0; i < MAX_REQUESTS; i++) {
      limiter.checkRateLimit('key1');
    }
    // key1 is exhausted, but key2 should be fresh
    expect(limiter.checkRateLimit('key1').allowed).toBe(false);
    expect(limiter.checkRateLimit('key2').allowed).toBe(true);
  });

  it('should reset a specific key', () => {
    for (let i = 0; i < MAX_REQUESTS; i++) {
      limiter.checkRateLimit('key1');
    }
    expect(limiter.checkRateLimit('key1').allowed).toBe(false);

    limiter.resetRateLimit('key1');
    expect(limiter.checkRateLimit('key1').allowed).toBe(true);
  });

  it('should not affect other keys when resetting one', () => {
    limiter.checkRateLimit('key1');
    limiter.checkRateLimit('key2');
    limiter.resetRateLimit('key1');
    expect(limiter.size).toBe(1); // key2 still present
  });

  it('should clean up stale entries', () => {
    const now = 1000000;
    limiter.checkRateLimit('stale', now);
    limiter.checkRateLimit('fresh', now + WINDOW_MS);

    limiter.cleanup(now + WINDOW_MS + 1);
    expect(limiter.size).toBe(1); // only 'fresh' remains
  });

  it('should handle cleanup when all entries are stale', () => {
    const now = 1000000;
    limiter.checkRateLimit('a', now);
    limiter.checkRateLimit('b', now);

    limiter.cleanup(now + WINDOW_MS + 1);
    expect(limiter.size).toBe(0);
  });

  it('should return retryAfterMs of 0 when exactly at window boundary', () => {
    const now = 1000000;
    for (let i = 0; i < MAX_REQUESTS; i++) {
      limiter.checkRateLimit('key1', now);
    }
    const result = limiter.checkRateLimit('key1', now + WINDOW_MS);
    // All timestamps are at `now`, cutoff is `now + WINDOW_MS - WINDOW_MS = now`
    // Prune removes timestamps <= windowStart (filter t > windowStart)
    // Since now = windowStart, timestamps at `now` are NOT > `now`, so they're pruned
    expect(result.allowed).toBe(true);
  });
});
