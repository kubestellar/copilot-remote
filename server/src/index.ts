import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { URL } from 'url';
import path from 'path';
import { fileURLToPath } from 'url';
import { getOrCreateToken, authMiddleware, validateWsToken } from './auth.js';
import { sessionManager } from './session-manager.js';
import { acpManager } from './acp-manager.js';
import { terminalManager } from './terminal-manager.js';
import { listHistoricalSessions, getSessionDetail, getSessionMessages, purgeSession } from './session-store.js';
import { getAllMeta, updateMeta, addTag, removeTag } from './session-meta.js';
import { getTodos, setTodos } from './todo-store.js';
import type { WsMessage, WsServerMessage } from './types.js';
import swarmRouter from './swarm-router.js';
import { loadSwarmKeys, generateSwarmKey, revokeSwarmKey, setSwarmEnabled, isSwarmEnabled } from './swarm-keys.js';
import { loadBlocklist as loadSwarmBlocklist } from './swarm-blocklist.js';
import { swarmTunnel } from './swarm-tunnel.js';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env.PORT || '3001', 10);
/** Directory where uploaded files (drag-drop images) are saved */
const UPLOAD_DIR = '/tmp/copilot-remote-uploads';
/** Maximum upload payload size (20 MB base64 ≈ 15 MB file) */
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
/** Only image MIME types are accepted for upload */
const ALLOWED_MIME_PREFIX = 'image/';
/** Maximum sanitized filename length */
const MAX_FILENAME_LENGTH = 255;

const app = express();
const server = createServer(app);

// Middleware
app.use(express.json({ limit: MAX_UPLOAD_BYTES }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
  next();
});
app.use('/api', authMiddleware);

// Ensure upload directory exists
if (!existsSync(UPLOAD_DIR)) mkdirSync(UPLOAD_DIR, { recursive: true });

// REST API
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', version: '0.1.0' });
});

// File upload endpoint (drag-drop images from browser → server filesystem)
app.post('/api/upload', (req, res) => {
  try {
    const { filename, data, mimeType } = req.body;
    if (!filename || !data) {
      res.status(400).json({ error: 'filename and data are required' });
      return;
    }
    if (mimeType && !mimeType.startsWith(ALLOWED_MIME_PREFIX)) {
      res.status(400).json({ error: `Only image files are allowed (got ${mimeType})` });
      return;
    }
    // Sanitize filename: strip path separators, limit length
    const safeName = filename.replace(/[/\\]/g, '_').slice(0, MAX_FILENAME_LENGTH);
    const finalName = `${Date.now()}-${safeName}`;
    const filePath = join(UPLOAD_DIR, finalName);

    const buffer = Buffer.from(data, 'base64');
    writeFileSync(filePath, buffer);

    res.json({ path: filePath });
  } catch (err: any) {
    console.error('[Upload] Failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sessions', (_req, res) => {
  const sessions = sessionManager.getAllSessions();
  const meta = getAllMeta();
  const enriched = sessions
    .filter(s => !meta[s.id]?.hidden)
    .map(s => ({
      ...s,
      name: meta[s.id]?.name,
      tags: meta[s.id]?.tags || [],
    }));
  res.json(enriched);
});

app.post('/api/sessions', async (req, res) => {
  try {
    const { prompt, cwd, resume } = req.body;
    const session = await sessionManager.createSession({ prompt, cwd, resume });
    res.status(201).json(session);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sessions/:id', (req, res) => {
  const meta = getAllMeta();
  const sessionMeta = meta[req.params.id] || {};

  const managed = sessionManager.getSession(req.params.id);
  // Always try to load historical messages from events.jsonl
  const historical = getSessionDetail(req.params.id);
  const historicalMessages = getSessionMessages(req.params.id);

  if (managed) {
    // Merge: historical messages + any in-memory messages from PTY
    const allMessages = historicalMessages.length > 0 ? historicalMessages : managed.messages;
    res.json({
      ...managed.session,
      name: sessionMeta.name,
      tags: sessionMeta.tags || [],
      messages: allMessages.slice(-500),
    });
    return;
  }
  if (historical) {
    res.json({ ...historical, name: sessionMeta.name, tags: sessionMeta.tags || [], messages: historicalMessages.slice(-500) });
    return;
  }
  res.status(404).json({ error: 'Session not found' });
});

// Session metadata CRUD
app.patch('/api/sessions/:id/meta', (req, res) => {
  const { name, tags } = req.body;
  const update: Record<string, any> = {};
  if (name !== undefined) update.name = name;
  if (tags !== undefined) update.tags = tags;
  const result = updateMeta(req.params.id, update);
  res.json(result);
});

app.post('/api/sessions/:id/tags', (req, res) => {
  const { tag } = req.body;
  if (!tag) { res.status(400).json({ error: 'tag required' }); return; }
  const tags = addTag(req.params.id, tag);
  res.json({ tags });
});

app.delete('/api/sessions/:id/tags/:tag', (req, res) => {
  const tags = removeTag(req.params.id, req.params.tag);
  res.json({ tags });
});

app.delete('/api/sessions/:id', (req, res) => {
  const killed = sessionManager.killSession(req.params.id);
  updateMeta(req.params.id, { hidden: true });
  res.json({ killed, hidden: true });
});

app.delete('/api/sessions/:id/purge', (req, res) => {
  sessionManager.killSession(req.params.id);
  const deleted = purgeSession(req.params.id);
  res.json({ deleted });
});

app.post('/api/sessions/:id/send', async (req, res) => {
  const { text } = req.body;
  if (!text) { res.status(400).json({ error: 'text required' }); return; }
  try {
    await acpManager.sendPrompt(req.params.id, text);
    res.json({ sent: true, via: 'acp' });
  } catch (acpErr) {
    console.debug(`[API] ACP send failed, falling back to PTY: ${(acpErr as any).message}`);
    const sent = sessionManager.sendInput(req.params.id, text);
    if (!sent) { res.status(404).json({ error: 'Session not running' }); return; }
    res.json({ sent: true, via: 'pty' });
  }
});

// WebSocket
const wss = new WebSocketServer({ noServer: true });

// Track subscriptions
const subscriptions = new Map<WebSocket, Set<string>>();

wss.on('connection', (ws, req) => {
  const url = new URL(req.url || '', `http://localhost:${PORT}`);
  const token = url.searchParams.get('token') || undefined;

  if (!validateWsToken(token)) {
    ws.close(4001, 'Invalid token');
    return;
  }

  subscriptions.set(ws, new Set());

  ws.on('message', (raw) => {
    try {
      const msg: WsMessage = JSON.parse(raw.toString());
      const subs = subscriptions.get(ws)!;

      switch (msg.type) {
        case 'subscribe':
          if (msg.sessionId) subs.add(msg.sessionId);
          break;
        case 'unsubscribe':
          if (msg.sessionId) subs.delete(msg.sessionId);
          break;
        case 'input':
          if (msg.sessionId && msg.text) {
            const sid = msg.sessionId;
            const text = msg.text;
            // Use ACP for streaming — it creates its own copilot process
            acpManager.sendPrompt(sid, text).catch((err) => {
              console.error(`[ACP] Prompt failed for ${sid.slice(0, 8)}: ${err.message}`);
              // Notify the web client of the error
              broadcast(sid, {
                type: 'error',
                sessionId: sid,
                error: `Failed to send: ${err.message}`,
                timestamp: new Date().toISOString(),
              });
            });
          }
          break;

      }
    } catch (parseErr) {
      console.debug('[WS] Malformed message ignored:', parseErr);
    }
  });

  ws.on('close', () => {
    subscriptions.delete(ws);
  });
});

// Broadcast session events to subscribers
function broadcast(sessionId: string, msg: WsServerMessage) {
  const data = JSON.stringify(msg);
  for (const [ws, subs] of subscriptions) {
    if (ws.readyState === WebSocket.OPEN && subs.has(sessionId)) {
      ws.send(data);
    }
  }
}

sessionManager.on('output', (sessionId: string, data: string) => {
  broadcast(sessionId, { type: 'output', sessionId, data, timestamp: new Date().toISOString() });
});

sessionManager.on('status', (sessionId: string, status: string) => {
  broadcast(sessionId, { type: 'status', sessionId, status: status as any });
});

sessionManager.on('message', (sessionId: string, message: any) => {
  broadcast(sessionId, { type: 'message', sessionId, message });
});

// Watch events.jsonl files for live CLI sessions
import { watchSessionEvents } from './session-watcher.js';

const sessionWatcher = watchSessionEvents((sessionId, message) => {
  // Skip broadcasting watcher events for sessions with active ACP connections (dedup)
  if (acpManager.hasSession(sessionId)) return;
  broadcast(sessionId, { type: 'message', sessionId, message });
});

// ACP streaming events → WebSocket broadcast
acpManager.on('chunk', (sessionId: string, text: string) => {
  broadcast(sessionId, { type: 'stream', sessionId, text, timestamp: new Date().toISOString() });
});

acpManager.on('tool', (sessionId: string, tool: any) => {
  broadcast(sessionId, { type: 'tool', sessionId, tool, timestamp: new Date().toISOString() });
});

acpManager.on('turn_complete', (sessionId: string, stopReason: string) => {
  broadcast(sessionId, { type: 'turn_complete', sessionId, stopReason, timestamp: new Date().toISOString() });
});

acpManager.on('error', (sessionId: string, err: Error) => {
  broadcast(sessionId, { type: 'error', sessionId, error: err.message, timestamp: new Date().toISOString() });
});

// Terminal REST endpoints
app.get('/api/terminals', (_req, res) => {
  res.json(terminalManager.list());
});

app.post('/api/terminals', (req, res) => {
  try {
    const { cwd, aiCli } = req.body || {};
    const id = `term-${Date.now()}`;
    const terminal = terminalManager.create(id, cwd, aiCli);
    res.status(201).json({ id: terminal.id, cwd: terminal.cwd, createdAt: terminal.createdAt, tmuxSession: terminal.tmuxSession });
  } catch (err: any) {
    console.error('[Terminal] Failed to create:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/ai-clis', (_req, res) => {
  res.json(terminalManager.listAiClis());
});

app.post('/api/terminals/attach', (req, res) => {
  try {
    const { tmuxSession } = req.body || {};
    if (!tmuxSession) return res.status(400).json({ error: 'tmuxSession is required' });
    // Return existing terminal for this tmux session if one exists
    const existing = terminalManager.list().find(t => t.tmuxSession === tmuxSession);
    if (existing) {
      return res.status(200).json({ id: existing.id, cwd: existing.cwd, createdAt: existing.createdAt, tmuxSession: existing.tmuxSession });
    }
    const id = `term-${Date.now()}`;
    const terminal = terminalManager.attach(id, tmuxSession);
    res.status(201).json({ id: terminal.id, cwd: terminal.cwd, createdAt: terminal.createdAt, tmuxSession: terminal.tmuxSession });
  } catch (err: any) {
    console.error('[Terminal] Failed to attach:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/tmux-sessions', (_req, res) => {
  // Filter out cr-* sessions (copilot-remote's own) and already-managed ones
  const managed = new Set(terminalManager.list().map(t => t.tmuxSession));
  const available = terminalManager.listTmuxSessions().filter(s => !managed.has(s) && !s.startsWith('cr-'));
  res.json(available);
});

app.get('/api/tmux-sessions/:name/title', (req, res) => {
  const title = terminalManager.getTmuxPaneTitle(req.params.name);
  res.json({ title });
});

app.delete('/api/terminals/:id', (req, res) => {
  const killed = terminalManager.destroy(req.params.id);
  res.json({ killed });
});

app.delete('/api/tmux-sessions/:name', (req, res) => {
  const killed = terminalManager.killTmuxSession(req.params.name);
  res.json({ killed });
});

// Todo queue REST endpoints
app.get('/api/todos', (_req, res) => {
  res.json(getTodos());
});

app.put('/api/todos', (req, res) => {
  const { items, todoMode } = req.body;
  if (!Array.isArray(items)) {
    res.status(400).json({ error: 'items must be an array' });
    return;
  }
  setTodos(items, !!todoMode);
  res.json({ ok: true });
});

// Mount swarm API router (uses its own auth middleware)
app.use('/swarm/api', swarmRouter);

// Swarm management routes (owner-only, uses existing authMiddleware via /api prefix)
app.get('/api/swarm/status', (_req, res) => {
  const store = loadSwarmKeys();
  const tunnel = swarmTunnel.getStatus();
  res.json({
    enabled: store.enabled,
    keyCount: store.keys.length,
    tunnelUrl: tunnel.url,
    tunnelRunning: tunnel.running,
    tunnelProvider: tunnel.provider,
  });
});

app.put('/api/swarm/enabled', (req, res) => {
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    res.status(400).json({ error: 'enabled must be a boolean' });
    return;
  }
  setSwarmEnabled(enabled);
  res.json({ enabled });
});

app.post('/api/swarm/keys', (req, res) => {
  const { label } = req.body;
  if (!label || typeof label !== 'string') {
    res.status(400).json({ error: 'label is required' });
    return;
  }
  const key = generateSwarmKey(label.trim());
  const tunnel = swarmTunnel.getStatus();
  const baseUrl = tunnel.url || `http://localhost:${PORT}`;
  res.status(201).json({
    ...key,
    inviteUrl: `${baseUrl}/swarm?key=${key.key}`,
  });
});

app.get('/api/swarm/keys', (_req, res) => {
  const store = loadSwarmKeys();
  /** Number of hex characters to show in masked key */
  const MASK_VISIBLE_CHARS = 8;
  const masked = store.keys.map(k => ({
    ...k,
    key: k.key.slice(0, MASK_VISIBLE_CHARS) + '...',
    fullKey: k.key,
  }));
  res.json(masked);
});

app.delete('/api/swarm/keys/:key', (req, res) => {
  const revoked = revokeSwarmKey(req.params.key);
  if (!revoked) {
    res.status(404).json({ error: 'Key not found' });
    return;
  }
  res.json({ revoked: true });
});

app.get('/api/swarm/blocklist', (_req, res) => {
  res.json(loadSwarmBlocklist());
});

app.put('/api/swarm/blocklist', (req, res) => {
  const { patterns } = req.body;
  if (!Array.isArray(patterns)) {
    res.status(400).json({ error: 'patterns must be an array' });
    return;
  }
  const blocklistFile = join(homedir(), '.copilot-remote', 'swarm-blocklist.json');
  writeFileSync(blocklistFile, JSON.stringify(patterns, null, 2));
  res.json({ ok: true, count: patterns.length });
});

app.get('/api/swarm/tunnel', (_req, res) => {
  res.json(swarmTunnel.getStatus());
});

app.post('/api/swarm/tunnel/start', async (_req, res) => {
  try {
    const url = await swarmTunnel.start(PORT);
    res.json({ url, provider: swarmTunnel.getStatus().provider });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/swarm/tunnel/stop', (_req, res) => {
  swarmTunnel.stop();
  res.json({ stopped: true });
});

// Serve built frontend (production)
const DIST_DIR = path.join(__dirname, '..', '..', 'dist');
app.use(express.static(DIST_DIR));

// Swarm page route
app.get('/swarm', (_req, res) => {
  res.sendFile(path.join(DIST_DIR, 'swarm.html'));
});

// SPA fallback (must be last static route — Express 5 uses {*path} syntax)
app.get('{*path}', (req, res, next) => {
  // Skip API and WebSocket paths
  if (req.path.startsWith('/api') || req.path.startsWith('/ws') || req.path.startsWith('/swarm/api')) {
    next();
    return;
  }
  res.sendFile(path.join(DIST_DIR, 'index.html'));
});

// Terminal WebSocket — separate path for raw PTY I/O
const termWss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '', `http://localhost:${PORT}`);
  const token = url.searchParams.get('token') || undefined;

  if (!validateWsToken(token)) {
    socket.destroy();
    return;
  }

  if (url.pathname === '/ws/terminal') {
    termWss.handleUpgrade(req, socket, head, (ws) => {
      termWss.emit('connection', ws, req);
    });
  } else if (url.pathname === '/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

termWss.on('connection', (ws, req) => {
  const url = new URL(req.url || '', `http://localhost:${PORT}`);
  const termId = url.searchParams.get('id') || undefined;

  if (!termId) {
    ws.close(4002, 'Terminal id required');
    return;
  }

  // Only reconnect to existing terminals — don't auto-create
  if (!terminalManager.get(termId)) {
    ws.close(4003, 'Terminal not found');
    return;
  }

  // Forward PTY output → WebSocket
  let ptyPaused = false;
  const onData = (id: string, data: string) => {
    if (id === termId && ws.readyState === WebSocket.OPEN && !ptyPaused) {
      ws.send(data);
    }
  };
  const onExit = (id: string, exitCode: number) => {
    if (id === termId && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'exit', id: termId, exitCode }));
      ws.send(`\r\n[Process exited with code ${exitCode}]\r\n`);
      ws.close(1000);
    }
  };
  // Forward command name changes (for tab labels)
  const onCommand = (id: string, cmd: string) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'command', id, command: cmd }));
    }
  };
  // Forward prompt detection (for todo dispatcher)
  const onPrompt = (id: string) => {
    if (id === termId && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'prompt', id: termId }));
    }
  };

  terminalManager.on('data', onData);
  terminalManager.on('exit', onExit);
  terminalManager.on('command', onCommand);
  terminalManager.on('prompt', onPrompt);

  // WebSocket input → PTY
  ws.on('message', (raw) => {
    const msg = raw.toString();
    try {
      const parsed = JSON.parse(msg);
      if (parsed.type === 'resize' && parsed.cols && parsed.rows) {
        terminalManager.resize(termId, parsed.cols, parsed.rows);
        return;
      }
      // Flow control: frontend signals backpressure
      if (parsed.type === 'pause') {
        ptyPaused = true;
        return;
      }
      if (parsed.type === 'resume') {
        ptyPaused = false;
        return;
      }
      if (parsed.type === 'watch-prompt') {
        terminalManager.watchForPrompt(termId);
        return;
      }
      if (parsed.type === 'unwatch-prompt') {
        terminalManager.unwatchPrompt(termId);
        return;
      }
    } catch (_parseErr) {
      // Not JSON — raw terminal input
    }
    terminalManager.write(termId, msg);
  });

  ws.on('close', () => {
    terminalManager.removeListener('data', onData);
    terminalManager.removeListener('exit', onExit);
    terminalManager.removeListener('command', onCommand);
    terminalManager.removeListener('prompt', onPrompt);
  });
});

// Auto-discover new non-cr-* tmux sessions and broadcast to terminal WS clients
let knownTmuxSessions = new Set<string>();
setInterval(() => {
  const managed = new Set(terminalManager.list().map(t => t.tmuxSession));
  const allSessions = terminalManager.listTmuxSessions().filter(s => !s.startsWith('cr-'));
  const newSessions: string[] = [];
  for (const s of allSessions) {
    if (!knownTmuxSessions.has(s) && !managed.has(s)) {
      newSessions.push(s);
    }
  }
  // Update known set to current reality (remove gone sessions too)
  knownTmuxSessions = new Set([...allSessions, ...Array.from(managed)]);
  if (newSessions.length > 0) {
    const msg = JSON.stringify({ type: 'tmux-discovered', sessions: newSessions });
    for (const client of termWss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(msg);
      }
    }
  }
}, 3000);

// Start
server.listen(PORT, '0.0.0.0', () => {
  const token = getOrCreateToken();
  // Re-adopt orphaned cr-* tmux sessions from previous server runs
  const adopted = terminalManager.reAdoptOrphanedSessions();
  if (adopted > 0) console.log(`♻️  Re-adopted ${adopted} orphaned tmux session(s)`);
  console.log(`\n🚀 Copilot Remote server running on http://0.0.0.0:${PORT}`);
  console.log(`\n🔑 Auth token: ${token}`);
  console.log(`\n   Use this token to connect from your phone.`);
  console.log(`   It's saved in ~/.copilot-remote/auth-token\n`);
});
