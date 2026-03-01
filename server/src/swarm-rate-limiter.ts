/** Sliding window duration in milliseconds (1 minute) */
const SWARM_RATE_LIMIT_WINDOW_MS = 60_000;

/** Maximum requests allowed per key within the window */
const SWARM_RATE_LIMIT_MAX_REQUESTS = 10;

/** Interval for cleaning up stale rate limit entries (5 minutes) */
const SWARM_RATE_LIMIT_CLEANUP_INTERVAL_MS = 300_000;

/** In-memory map: swarm key → list of request timestamps */
const buckets = new Map<string, number[]>();

export interface RateLimitResult {
  allowed: boolean;
  retryAfterMs?: number;
}

/**
 * Check if a swarm key is within its rate limit.
 * Uses a sliding window: only timestamps within SWARM_RATE_LIMIT_WINDOW_MS are counted.
 */
export function checkRateLimit(key: string): RateLimitResult {
  const now = Date.now();
  const windowStart = now - SWARM_RATE_LIMIT_WINDOW_MS;

  let timestamps = buckets.get(key) || [];
  // Prune timestamps outside the window
  timestamps = timestamps.filter(t => t > windowStart);

  if (timestamps.length >= SWARM_RATE_LIMIT_MAX_REQUESTS) {
    // Find when the oldest timestamp in the window will expire
    const oldestInWindow = timestamps[0];
    const retryAfterMs = oldestInWindow + SWARM_RATE_LIMIT_WINDOW_MS - now;
    buckets.set(key, timestamps);
    return { allowed: false, retryAfterMs: Math.max(retryAfterMs, 0) };
  }

  timestamps.push(now);
  buckets.set(key, timestamps);
  return { allowed: true };
}

/**
 * Reset rate limit counters for a specific key (e.g., when key is revoked).
 */
export function resetRateLimit(key: string): void {
  buckets.delete(key);
}

/**
 * Periodically clean up stale entries from the rate limit map.
 * Entries are stale if all timestamps are outside the current window.
 */
function cleanup(): void {
  const cutoff = Date.now() - SWARM_RATE_LIMIT_WINDOW_MS;
  for (const [key, timestamps] of buckets) {
    const active = timestamps.filter(t => t > cutoff);
    if (active.length === 0) {
      buckets.delete(key);
    } else {
      buckets.set(key, active);
    }
  }
}

// Start periodic cleanup
setInterval(cleanup, SWARM_RATE_LIMIT_CLEANUP_INTERVAL_MS).unref();
