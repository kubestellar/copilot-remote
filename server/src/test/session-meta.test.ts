/**
 * Tests for session metadata store — CRUD operations on names, tags, hidden flag.
 *
 * Uses a temp file to avoid touching real user data.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// We need to intercept the file path used by session-meta.ts.
// Since the module uses homedir() at import time, we mock os.homedir().
const tempDir = mkdtempSync(join(tmpdir(), 'meta-test-'));
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tempDir };
});

// Import after mock is set up
const { getMeta, getAllMeta, updateMeta, addTag, removeTag } = await import('../session-meta.js');

describe('Session metadata store', () => {
  const metaFile = join(tempDir, '.copilot-remote', 'session-meta.json');

  afterEach(() => {
    // Clean the metadata file between tests
    try { rmSync(metaFile); } catch {}
  });

  // ── getMeta ───────────────────────────────────────────────────────────

  it('should return empty object for unknown session', () => {
    expect(getMeta('nonexistent')).toEqual({});
  });

  // ── updateMeta ────────────────────────────────────────────────────────

  it('should create metadata for new session', () => {
    const result = updateMeta('s1', { name: 'My Session' });
    expect(result.name).toBe('My Session');
  });

  it('should merge updates without overwriting unrelated fields', () => {
    updateMeta('s1', { name: 'Session 1', hidden: false });
    const result = updateMeta('s1', { hidden: true });
    expect(result.name).toBe('Session 1');
    expect(result.hidden).toBe(true);
  });

  it('should persist to disk', () => {
    updateMeta('s1', { name: 'Persisted' });
    expect(existsSync(metaFile)).toBe(true);
    const raw = JSON.parse(readFileSync(metaFile, 'utf-8'));
    expect(raw.s1.name).toBe('Persisted');
  });

  // ── getAllMeta ─────────────────────────────────────────────────────────

  it('should return all session metadata', () => {
    updateMeta('s1', { name: 'One' });
    updateMeta('s2', { name: 'Two' });
    const all = getAllMeta();
    expect(Object.keys(all)).toEqual(expect.arrayContaining(['s1', 's2']));
  });

  // ── addTag ────────────────────────────────────────────────────────────

  it('should add a tag to a session', () => {
    const tags = addTag('s1', 'important');
    expect(tags).toContain('important');
  });

  it('should not duplicate tags', () => {
    addTag('s1', 'work');
    const tags = addTag('s1', 'work');
    expect(tags.filter(t => t === 'work').length).toBe(1);
  });

  it('should accumulate multiple tags', () => {
    addTag('s1', 'a');
    addTag('s1', 'b');
    const tags = addTag('s1', 'c');
    expect(tags).toEqual(expect.arrayContaining(['a', 'b', 'c']));
  });

  // ── removeTag ─────────────────────────────────────────────────────────

  it('should remove a tag', () => {
    addTag('s1', 'temp');
    const tags = removeTag('s1', 'temp');
    expect(tags).not.toContain('temp');
  });

  it('should handle removing non-existent tag gracefully', () => {
    addTag('s1', 'keep');
    const tags = removeTag('s1', 'gone');
    expect(tags).toContain('keep');
  });

  it('should handle removeTag on session with no tags', () => {
    const tags = removeTag('s1', 'anything');
    expect(tags).toEqual([]);
  });

  // ── Edge cases ────────────────────────────────────────────────────────

  it('should handle concurrent updates to different sessions', () => {
    updateMeta('s1', { name: 'First' });
    updateMeta('s2', { name: 'Second' });
    expect(getMeta('s1').name).toBe('First');
    expect(getMeta('s2').name).toBe('Second');
  });

  it('should handle empty string name', () => {
    const result = updateMeta('s1', { name: '' });
    expect(result.name).toBe('');
  });
});
