import { readdirSync, readFileSync, existsSync, statSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { parse as parseYaml } from 'yaml';
import type { Session, ChatMessage } from './types.js';

const SESSION_STATE_DIR = join(homedir(), '.copilot', 'session-state');

interface WorkspaceYaml {
  id?: string;
  cwd?: string;
  summary?: string;
  created_at?: string;
  updated_at?: string;
}

export function listHistoricalSessions(): Session[] {
  if (!existsSync(SESSION_STATE_DIR)) return [];

  const sessions: Session[] = [];
  const now = Date.now();
  const ACTIVE_THRESHOLD_MS = 120_000; // 2 minutes

  try {
    const entries = readdirSync(SESSION_STATE_DIR, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const workspacePath = join(SESSION_STATE_DIR, entry.name, 'workspace.yaml');
      if (!existsSync(workspacePath)) continue;

      try {
        const raw = readFileSync(workspacePath, 'utf-8');
        const data = parseYaml(raw) as WorkspaceYaml;
        const stat = statSync(workspacePath);

        // Check if events.jsonl was recently modified (session is active in a terminal)
        const eventsPath = join(SESSION_STATE_DIR, entry.name, 'events.jsonl');
        let isActive = false;
        let lastInteraction: string | undefined;
        try {
          const eventsStat = statSync(eventsPath);
          isActive = (now - eventsStat.mtimeMs) < ACTIVE_THRESHOLD_MS;
          lastInteraction = eventsStat.mtime.toISOString();
        } catch (_err) { /* no events file */ }

        sessions.push({
          id: data.id || entry.name,
          cwd: data.cwd || '',
          summary: data.summary,
          status: isActive ? 'active' : 'exited',
          createdAt: data.created_at || stat.birthtime.toISOString(),
          updatedAt: lastInteraction || data.updated_at || stat.mtime.toISOString(),
        });
      } catch (err) {
        console.debug('[Store] Skipping malformed session directory:', err);
      }
    }
  } catch (err) {
    console.debug('[Store] Session state dir unreadable:', err);
  }

  // Sort by most recent first
  sessions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  return sessions;
}

export function getSessionDetail(sessionId: string): Session | null {
  const sessionDir = join(SESSION_STATE_DIR, sessionId);
  const workspacePath = join(sessionDir, 'workspace.yaml');

  if (!existsSync(workspacePath)) return null;

  try {
    const raw = readFileSync(workspacePath, 'utf-8');
    const data = parseYaml(raw) as WorkspaceYaml;
    const stat = statSync(workspacePath);

    return {
      id: data.id || sessionId,
      cwd: data.cwd || '',
      summary: data.summary,
      status: 'exited',
      createdAt: data.created_at || stat.birthtime.toISOString(),
      updatedAt: data.updated_at || stat.mtime.toISOString(),
    };
  } catch (err) {
    console.debug('[Store] Failed to read session detail:', err);
    return null;
  }
}

export function getSessionMessages(sessionId: string): ChatMessage[] {
  const eventsPath = join(SESSION_STATE_DIR, sessionId, 'events.jsonl');
  if (!existsSync(eventsPath)) return [];

  const messages: ChatMessage[] = [];
  try {
    const raw = readFileSync(eventsPath, 'utf-8');
    const lines = raw.split('\n').filter(l => l.trim());

    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (event.type === 'user.message') {
          const content = event.data?.content || '';
          if (content.trim()) {
            messages.push({
              id: event.id || '',
              role: 'user',
              content,
              timestamp: event.timestamp || event.data?.timestamp || '',
            });
          }
        } else if (event.type === 'assistant.message') {
          const content = event.data?.content || '';
          if (content.trim()) {
            messages.push({
              id: event.data.messageId || event.id || '',
              role: 'copilot',
              content,
              timestamp: event.timestamp || '',
            });
          }
        }
      } catch (err) {
        console.debug('[Store] Skipping malformed event line:', err);
      }
    }
  } catch (err) {
    console.debug('[Store] Events file unreadable:', err);
  }

  return messages;
}

/** Delete a session's directory from disk. Returns true if deleted. */
export function purgeSession(sessionId: string): boolean {
  // Validate session ID format to prevent path traversal
  if (!/^[a-f0-9-]+$/i.test(sessionId)) return false;
  const sessionDir = join(SESSION_STATE_DIR, sessionId);
  if (!existsSync(sessionDir)) return false;
  try {
    rmSync(sessionDir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}
