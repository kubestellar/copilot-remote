import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { URL } from 'url';
import { getOrCreateToken, authMiddleware, validateWsToken } from './auth.js';
import { sessionManager } from './session-manager.js';
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
  const enriched = sessions.map(s => ({
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
  if (managed) {
    res.json({
      ...managed.session,
      name: sessionMeta.name,
      tags: sessionMeta.tags || [],
      messages: managed.messages.slice(-100),
    });
    return;
  }
  // Check historical
  const historical = getSessionDetail(req.params.id);
  if (historical) {
    const messages = getSessionMessages(req.params.id);
    res.json({ ...historical, name: sessionMeta.name, tags: sessionMeta.tags || [], messages: messages.slice(-500) });
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
  res.json({ killed });
});

app.post('/api/sessions/:id/send', (req, res) => {
  const { text } = req.body;
  if (!text) { res.status(400).json({ error: 'text required' }); return; }
  const sent = sessionManager.sendInput(req.params.id, text);
  if (!sent) { res.status(404).json({ error: 'Session not running' }); return; }
  res.json({ sent: true });
});

// WebSocket
const wss = new WebSocketServer({ server, path: '/ws' });

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
            sessionManager.sendInput(msg.sessionId, msg.text);
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
  broadcast(sessionId, { type: 'message', sessionId, message });
});

// Start
server.listen(PORT, '0.0.0.0', () => {
  const token = getOrCreateToken();
  console.log(`\n🚀 Copilot Remote server running on http://0.0.0.0:${PORT}`);
  console.log(`\n🔑 Auth token: ${token}`);
  console.log(`\n   Use this token to connect from your phone.`);
  console.log(`   It's saved in ~/.copilot-remote/auth-token\n`);
});
