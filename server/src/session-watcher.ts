import { readFileSync, readdirSync, existsSync, statSync, openSync, readSync, closeSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { ChatMessage } from './types.js';

const SESSION_STATE_DIR = join(homedir(), '.copilot', 'session-state');
const POLL_INTERVAL_MS = 1500;

// Track byte offsets for efficient tailing
const fileOffsets = new Map<string, number>();

type MessageCallback = (sessionId: string, message: ChatMessage) => void;

function parseEvent(line: string): { type: string; data: any; id?: string; timestamp?: string } | null {
  try {
    return JSON.parse(line);
  } catch (_err) {
    return null;
  }
}

function readNewBytes(eventsPath: string): string | null {
  try {
    const stat = statSync(eventsPath);
    const currentOffset = fileOffsets.get(eventsPath) || 0;
    if (stat.size <= currentOffset) return null;

    const bytesToRead = stat.size - currentOffset;
    const buf = Buffer.alloc(bytesToRead);
    const fd = openSync(eventsPath, 'r');
    try {
      readSync(fd, buf, 0, bytesToRead, currentOffset);
    } finally {
      closeSync(fd);
    }
    fileOffsets.set(eventsPath, stat.size);
    return buf.toString('utf-8');
  } catch (err) {
    console.debug('[Watcher] Failed to read new bytes from', eventsPath, ':', err);
    return null;
  }
}

function processNewLines(sessionId: string, eventsPath: string, callback: MessageCallback) {
  const newContent = readNewBytes(eventsPath);
  if (!newContent) return;

  const lines = newContent.split('\n').filter(l => l.trim());

  for (const line of lines) {
    const event = parseEvent(line);
    if (!event) continue;

    if (event.type === 'user.message' && event.data?.content?.trim()) {
      callback(sessionId, {
        id: event.id || '',
        role: 'user',
        content: event.data.content,
        timestamp: event.timestamp || '',
      });
    } else if (event.type === 'assistant.message' && event.data?.content?.trim()) {
      callback(sessionId, {
        id: event.data.messageId || event.id || '',
        role: 'copilot',
        content: event.data.content,
        timestamp: event.timestamp || '',
      });
    }
  }
}

function initOffset(eventsPath: string) {
  try {
    const stat = statSync(eventsPath);
    fileOffsets.set(eventsPath, stat.size);
  } catch (err) {
    console.debug('[Watcher] Failed to initialize offset for', eventsPath, ':', err);
  }
}

export function watchSessionEvents(callback: MessageCallback) {
  if (!existsSync(SESSION_STATE_DIR)) return { stop: () => {} };

  // Initialize offsets for all existing sessions
  try {
    const entries = readdirSync(SESSION_STATE_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const eventsPath = join(SESSION_STATE_DIR, entry.name, 'events.jsonl');
        if (existsSync(eventsPath)) {
          initOffset(eventsPath);
        }
      }
    }
  } catch (err) {
    console.debug('[Watcher] Failed to read session state directory during init:', err);
  }

  // Poll all sessions for changes
  const interval = setInterval(() => {
    try {
      const entries = readdirSync(SESSION_STATE_DIR, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const eventsPath = join(SESSION_STATE_DIR, entry.name, 'events.jsonl');
        if (!existsSync(eventsPath)) continue;

        // Initialize offset for new sessions
        if (!fileOffsets.has(eventsPath)) {
          initOffset(eventsPath);
          continue;
        }

        processNewLines(entry.name, eventsPath, callback);
      }
    } catch (err) {
      console.debug('[Watcher] Polling error:', err);
    }
  }, POLL_INTERVAL_MS);

  console.log(`👀 Watching ${fileOffsets.size} session(s) for live updates (polling every ${POLL_INTERVAL_MS}ms)`);

  return {
    stop: () => {
      clearInterval(interval);
    },
  };
}
