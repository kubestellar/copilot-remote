import { randomBytes, timingSafeEqual } from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { Request, Response, NextFunction } from 'express';
import { validateSwarmKey, isSwarmEnabled } from './swarm-keys.js';
import { checkRateLimit } from './swarm-rate-limiter.js';
import type { SwarmKey } from './swarm-keys.js';

const CONFIG_DIR = join(homedir(), '.copilot-remote');
const TOKEN_FILE = join(CONFIG_DIR, 'auth-token');

let authToken: string;

export function getOrCreateToken(): string {
  if (authToken) return authToken;

  if (existsSync(TOKEN_FILE)) {
    authToken = readFileSync(TOKEN_FILE, 'utf-8').trim();
  } else {
    mkdirSync(CONFIG_DIR, { recursive: true });
    authToken = randomBytes(32).toString('hex');
    writeFileSync(TOKEN_FILE, authToken, { mode: 0o600 });
  }

  return authToken;
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Skip auth for health check
  if (req.path === '/api/health') {
    next();
    return;
  }

  const token = req.headers.authorization?.replace('Bearer ', '') ||
                req.query.token as string;

  if (!token) {
    res.status(401).json({ error: 'Authorization required' });
    return;
  }

  const expected = Buffer.from(getOrCreateToken());
  const provided = Buffer.from(token);

  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    res.status(403).json({ error: 'Invalid token' });
    return;
  }

  next();
}

export function validateWsToken(token: string | undefined): boolean {
  if (!token) return false;
  const expected = Buffer.from(getOrCreateToken());
  const provided = Buffer.from(token);
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

/** Extend Express Request to carry validated swarm key */
declare global {
  namespace Express {
    interface Request {
      swarmKey?: SwarmKey;
    }
  }
}

/**
 * Auth middleware for swarm routes (/swarm/api/*).
 * Validates swarm key from query param or Authorization header,
 * checks that swarm mode is enabled, and enforces rate limits.
 */
export function swarmAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Swarm status endpoint is unauthenticated
  if (req.path === '/status') {
    next();
    return;
  }

  if (!isSwarmEnabled()) {
    res.status(503).json({ error: 'Swarm mode is not enabled' });
    return;
  }

  const key = req.headers.authorization?.replace('Bearer ', '') ||
              req.query.key as string;

  if (!key) {
    res.status(401).json({ error: 'Swarm key required' });
    return;
  }

  const validatedKey = validateSwarmKey(key);
  if (!validatedKey) {
    res.status(403).json({ error: 'Invalid or disabled swarm key' });
    return;
  }

  // Rate limit check
  const rateResult = checkRateLimit(key);
  if (!rateResult.allowed) {
    res.status(429).json({
      error: 'Rate limit exceeded',
      retryAfterMs: rateResult.retryAfterMs,
    });
    return;
  }

  req.swarmKey = validatedKey;
  next();
}
