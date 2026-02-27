import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { URL } from 'url';
import { getOrCreateToken, authMiddleware, validateWsToken } from './auth.js';
import { sessionManager } from './session-manager.js';
import { acpManager } from './acp-manager.js';
import { terminalManager } from './terminal-manager.js';
import { listHistoricalSessions, getSessionDetail, getSessionMessages } from './session-store.js';
import { getAllMeta, updateMeta, addTag, removeTag } from './session-meta.js';
import type { WsMessage, WsServerMessage } from './types.js';

const PORT = parseInt(process.env.PORT || '3001', 10);
const app = express();
const server = createServer(app);

// Middleware
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
  next();
});
app.use('/api', authMiddleware);

// REST API
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', version: '0.1.0' });
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

app.post('/api/sessions/:id/send', async (req, res) => {
  const { text } = req.body;
  if (!text) { res.status(400).json({ error: 'text required' }); return; }
  try {
    await acpManager.sendPrompt(req.params.id, text);
    res.json({ sent: true, via: 'acp' });
  } catch {
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
    } catch {
      // Ignore malformed messages
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

app.delete('/api/terminals/:id', (req, res) => {
  const killed = terminalManager.destroy(req.params.id);
  res.json({ killed });
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
  const onData = (id: string, data: string) => {
    if (id === termId && ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  };
  const onExit = (id: string, exitCode: number) => {
    if (id === termId && ws.readyState === WebSocket.OPEN) {
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

  terminalManager.on('data', onData);
  terminalManager.on('exit', onExit);
  terminalManager.on('command', onCommand);

  // WebSocket input → PTY
  ws.on('message', (raw) => {
    const msg = raw.toString();
    try {
      const parsed = JSON.parse(msg);
      if (parsed.type === 'resize' && parsed.cols && parsed.rows) {
        terminalManager.resize(termId, parsed.cols, parsed.rows);
        return;
      }
    } catch {
      // Not JSON — raw terminal input
    }
    terminalManager.write(termId, msg);
  });

  ws.on('close', () => {
    terminalManager.removeListener('data', onData);
    terminalManager.removeListener('exit', onExit);
    terminalManager.removeListener('command', onCommand);
  });
});

// Start
server.listen(PORT, '0.0.0.0', () => {
  const token = getOrCreateToken();
  console.log(`\n🚀 Copilot Remote server running on http://0.0.0.0:${PORT}`);
  console.log(`\n🔑 Auth token: ${token}`);
  console.log(`\n   Use this token to connect from your phone.`);
  console.log(`   It's saved in ~/.copilot-remote/auth-token\n`);
});
