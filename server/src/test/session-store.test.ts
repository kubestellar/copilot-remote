/**
 * Tests for session store — reading historical session data from the filesystem
 * and purging sessions (session CRUD backing layer for the API routes).
 *
 * Uses a temp directory to avoid touching real user data.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock os.homedir() so SESSION_STATE_DIR points to our temp dir.
// Must be set up before the module is imported.
const tempHome = mkdtempSync(join(tmpdir(), 'session-store-test-'));
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tempHome };
});

const { listHistoricalSessions, getSessionDetail, getSessionMessages, purgeSession } =
  await import('../session-store.js');

/** Returns the session-state directory under the temp home. */
const stateDir = () => join(tempHome, '.copilot', 'session-state');

/** Creates a minimal session directory for testing. */
function makeSessionDir(
  sessionId: string,
  opts: {
    id?: string;
    cwd?: string;
    summary?: string;
    created_at?: string;
    updated_at?: string;
    events?: string;
  } = {}
) {
  const dir = join(stateDir(), sessionId);
  mkdirSync(dir, { recursive: true });

  const yaml = [
    opts.id !== undefined ? `id: ${opts.id || sessionId}` : `id: ${sessionId}`,
    `cwd: ${opts.cwd || '/home/user/project'}`,
    opts.summary ? `summary: ${opts.summary}` : null,
    opts.created_at ? `created_at: ${opts.created_at}` : null,
    opts.updated_at ? `updated_at: ${opts.updated_at}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  writeFileSync(join(dir, 'workspace.yaml'), yaml + '\n');

  if (opts.events !== undefined) {
    writeFileSync(join(dir, 'events.jsonl'), opts.events);
  }
}

describe('Session store — listHistoricalSessions', () => {
  afterEach(() => {
    // Wipe the session-state dir between tests
    try { rmSync(stateDir(), { recursive: true, force: true }); } catch {}
  });

  it('should return empty array when session-state dir does not exist', () => {
    const sessions = listHistoricalSessions();
    expect(sessions).toEqual([]);
  });

  it('should return one session for a valid workspace.yaml', () => {
    mkdirSync(stateDir(), { recursive: true });
    makeSessionDir('abc-123', { cwd: '/home/user/project' });

    const sessions = listHistoricalSessions();
    expect(sessions.length).toBe(1);
    expect(sessions[0].id).toBe('abc-123');
    expect(sessions[0].cwd).toBe('/home/user/project');
  });

  it('should mark session as exited when no events.jsonl', () => {
    mkdirSync(stateDir(), { recursive: true });
    makeSessionDir('s1');

    const [session] = listHistoricalSessions();
    expect(session.status).toBe('exited');
  });

  it('should include optional summary field', () => {
    mkdirSync(stateDir(), { recursive: true });
    makeSessionDir('s2', { summary: 'Fix the build' });

    const [session] = listHistoricalSessions();
    expect(session.summary).toBe('Fix the build');
  });

  it('should list multiple sessions', () => {
    mkdirSync(stateDir(), { recursive: true });
    makeSessionDir('s-a', { updated_at: '2024-01-02T00:00:00.000Z' });
    makeSessionDir('s-b', { updated_at: '2024-01-01T00:00:00.000Z' });

    const sessions = listHistoricalSessions();
    expect(sessions.length).toBe(2);
  });

  it('should sort sessions with most-recently-updated first', () => {
    mkdirSync(stateDir(), { recursive: true });
    makeSessionDir('older', { updated_at: '2024-01-01T00:00:00.000Z' });
    makeSessionDir('newer', { updated_at: '2024-06-01T00:00:00.000Z' });

    const sessions = listHistoricalSessions();
    expect(sessions[0].id).toBe('newer');
    expect(sessions[1].id).toBe('older');
  });

  it('should skip entries without workspace.yaml', () => {
    mkdirSync(stateDir(), { recursive: true });
    // An entry with no workspace.yaml
    mkdirSync(join(stateDir(), 'no-yaml'), { recursive: true });
    makeSessionDir('valid');

    const sessions = listHistoricalSessions();
    expect(sessions.length).toBe(1);
    expect(sessions[0].id).toBe('valid');
  });
});

describe('Session store — getSessionDetail', () => {
  afterEach(() => {
    try { rmSync(stateDir(), { recursive: true, force: true }); } catch {}
  });

  it('should return null for non-existent session', () => {
    const result = getSessionDetail('does-not-exist');
    expect(result).toBeNull();
  });

  it('should return session detail for an existing session', () => {
    mkdirSync(stateDir(), { recursive: true });
    makeSessionDir('detail-test', { cwd: '/tmp/my-project', summary: 'My work' });

    const session = getSessionDetail('detail-test');
    expect(session).not.toBeNull();
    expect(session!.id).toBe('detail-test');
    expect(session!.cwd).toBe('/tmp/my-project');
    expect(session!.summary).toBe('My work');
    expect(session!.status).toBe('exited');
  });
});

describe('Session store — getSessionMessages', () => {
  afterEach(() => {
    try { rmSync(stateDir(), { recursive: true, force: true }); } catch {}
  });

  it('should return empty array when no events.jsonl', () => {
    mkdirSync(stateDir(), { recursive: true });
    makeSessionDir('no-events');

    const messages = getSessionMessages('no-events');
    expect(messages).toEqual([]);
  });

  it('should parse user.message events', () => {
    mkdirSync(stateDir(), { recursive: true });
    const event = JSON.stringify({
      id: 'evt-1',
      type: 'user.message',
      timestamp: '2024-01-01T00:00:00.000Z',
      data: { content: 'Hello, copilot!' },
    });
    makeSessionDir('with-user-msg', { events: event + '\n' });

    const messages = getSessionMessages('with-user-msg');
    expect(messages.length).toBe(1);
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toBe('Hello, copilot!');
  });

  it('should parse assistant.message events', () => {
    mkdirSync(stateDir(), { recursive: true });
    const event = JSON.stringify({
      id: 'evt-2',
      type: 'assistant.message',
      timestamp: '2024-01-01T00:00:01.000Z',
      data: { messageId: 'msg-1', content: 'Hi! How can I help?' },
    });
    makeSessionDir('with-assistant-msg', { events: event + '\n' });

    const messages = getSessionMessages('with-assistant-msg');
    expect(messages.length).toBe(1);
    expect(messages[0].role).toBe('copilot');
    expect(messages[0].content).toBe('Hi! How can I help?');
  });

  it('should skip events with empty content', () => {
    mkdirSync(stateDir(), { recursive: true });
    const events = [
      JSON.stringify({ id: 'e1', type: 'user.message', data: { content: '' } }),
      JSON.stringify({ id: 'e2', type: 'user.message', data: { content: 'Real message' } }),
    ].join('\n');
    makeSessionDir('mixed-content', { events });

    const messages = getSessionMessages('mixed-content');
    expect(messages.length).toBe(1);
    expect(messages[0].content).toBe('Real message');
  });

  it('should skip malformed JSON lines', () => {
    mkdirSync(stateDir(), { recursive: true });
    const events = [
      'not valid json',
      JSON.stringify({ id: 'e1', type: 'user.message', data: { content: 'Good' } }),
    ].join('\n');
    makeSessionDir('malformed', { events });

    const messages = getSessionMessages('malformed');
    expect(messages.length).toBe(1);
    expect(messages[0].content).toBe('Good');
  });
});

describe('Session store — purgeSession', () => {
  afterEach(() => {
    try { rmSync(stateDir(), { recursive: true, force: true }); } catch {}
  });

  it('should return false for a non-existent session', () => {
    mkdirSync(stateDir(), { recursive: true });
    expect(purgeSession('aabbccdd-0011-2233-4455-66778899aabb')).toBe(false);
  });

  it('should delete the session directory and return true', () => {
    mkdirSync(stateDir(), { recursive: true });
    const id = 'abcdef12-3456-7890-abcd-ef0123456789';
    makeSessionDir(id);

    const dir = join(stateDir(), id);
    expect(existsSync(dir)).toBe(true);

    const result = purgeSession(id);
    expect(result).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });

  it('should reject session IDs with path traversal characters', () => {
    // "../etc" contains a non-hex/non-dash char and should be rejected
    expect(purgeSession('../etc/passwd')).toBe(false);
  });

  it('should reject session IDs with non-UUID characters', () => {
    expect(purgeSession('../../secret')).toBe(false);
    expect(purgeSession('foo/bar')).toBe(false);
  });

  it('should accept valid UUID-style IDs', () => {
    mkdirSync(stateDir(), { recursive: true });
    const id = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    makeSessionDir(id);

    const result = purgeSession(id);
    expect(result).toBe(true);
  });
});
