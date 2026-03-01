import { randomBytes, timingSafeEqual } from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

/** Number of random bytes for swarm key generation (128-bit) */
const SWARM_KEY_BYTES = 16;

/** Path to the swarm keys JSON file */
const SWARM_KEYS_FILE = join(homedir(), '.copilot-remote', 'swarm-keys.json');

export interface SwarmKey {
  key: string;              // hex string
  label: string;            // human-readable name ("Alice", "Team-Beta")
  createdAt: string;        // ISO timestamp
  enabled: boolean;         // can be disabled without deleting
  lastUsedAt: string | null;
}

interface SwarmKeyStore {
  enabled: boolean;         // global swarm mode on/off
  keys: SwarmKey[];
}

function ensureDir(): void {
  const dir = join(homedir(), '.copilot-remote');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function loadSwarmKeys(): SwarmKeyStore {
  try {
    if (existsSync(SWARM_KEYS_FILE)) {
      return JSON.parse(readFileSync(SWARM_KEYS_FILE, 'utf-8'));
    }
  } catch (err) {
    console.debug('[Swarm] Failed to load swarm keys:', err);
  }
  return { enabled: false, keys: [] };
}

export function saveSwarmKeys(store: SwarmKeyStore): void {
  ensureDir();
  writeFileSync(SWARM_KEYS_FILE, JSON.stringify(store, null, 2), { mode: 0o600 });
}

export function generateSwarmKey(label: string): SwarmKey {
  const store = loadSwarmKeys();
  const newKey: SwarmKey = {
    key: randomBytes(SWARM_KEY_BYTES).toString('hex'),
    label,
    createdAt: new Date().toISOString(),
    enabled: true,
    lastUsedAt: null,
  };
  store.keys.push(newKey);
  saveSwarmKeys(store);
  return newKey;
}

/**
 * Validate a swarm key using timing-safe comparison.
 * Returns the matching SwarmKey if valid and enabled, null otherwise.
 */
export function validateSwarmKey(candidateKey: string): SwarmKey | null {
  const store = loadSwarmKeys();
  if (!store.enabled) return null;

  const candidateBuf = Buffer.from(candidateKey);
  for (const entry of store.keys) {
    if (!entry.enabled) continue;
    const storedBuf = Buffer.from(entry.key);
    if (candidateBuf.length === storedBuf.length && timingSafeEqual(candidateBuf, storedBuf)) {
      // Update last-used timestamp
      entry.lastUsedAt = new Date().toISOString();
      saveSwarmKeys(store);
      return entry;
    }
  }
  return null;
}

export function revokeSwarmKey(key: string): boolean {
  const store = loadSwarmKeys();
  const idx = store.keys.findIndex(k => k.key === key);
  if (idx === -1) return false;
  store.keys.splice(idx, 1);
  saveSwarmKeys(store);
  return true;
}

export function setSwarmEnabled(enabled: boolean): void {
  const store = loadSwarmKeys();
  store.enabled = enabled;
  saveSwarmKeys(store);
}

export function isSwarmEnabled(): boolean {
  return loadSwarmKeys().enabled;
}
