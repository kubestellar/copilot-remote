import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const META_DIR = join(homedir(), '.copilot-remote');
const META_FILE = join(META_DIR, 'session-meta.json');

export interface SessionMeta {
  name?: string;
  tags?: string[];
  hidden?: boolean;
}

type MetaStore = Record<string, SessionMeta>;

function load(): MetaStore {
  try {
    if (existsSync(META_FILE)) {
      return JSON.parse(readFileSync(META_FILE, 'utf-8'));
    }
  } catch { /* ignore */ }
  return {};
}

function save(store: MetaStore) {
  if (!existsSync(META_DIR)) mkdirSync(META_DIR, { recursive: true });
  writeFileSync(META_FILE, JSON.stringify(store, null, 2));
}

export function getMeta(sessionId: string): SessionMeta {
  return load()[sessionId] || {};
}

export function getAllMeta(): MetaStore {
  return load();
}

export function updateMeta(sessionId: string, update: Partial<SessionMeta>): SessionMeta {
  const store = load();
  const current = store[sessionId] || {};
  store[sessionId] = { ...current, ...update };
  save(store);
  return store[sessionId];
}

export function addTag(sessionId: string, tag: string): string[] {
  const store = load();
  const current = store[sessionId] || {};
  const tags = new Set(current.tags || []);
  tags.add(tag);
  store[sessionId] = { ...current, tags: [...tags] };
  save(store);
  return store[sessionId].tags!;
}

export function removeTag(sessionId: string, tag: string): string[] {
  const store = load();
  const current = store[sessionId] || {};
  const tags = (current.tags || []).filter(t => t !== tag);
  store[sessionId] = { ...current, tags };
  save(store);
  return tags;
}
