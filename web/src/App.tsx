import { useState, useCallback, useEffect, useRef } from 'react';
import { Box, Text, UnderlineNav } from '@primer/react';
import { TerminalIcon, CommentDiscussionIcon } from '@primer/octicons-react';
import { SessionList } from './components/SessionList';
import { ChatView } from './components/ChatView';
import { TerminalView } from './components/TerminalView';
import { ConnectionStatus } from './components/ConnectionStatus';
import { NewSessionDialog } from './components/NewSessionDialog';
import { useWebSocket } from './hooks/useWebSocket';
import { useSessions } from './hooks/useSessions';
import { api } from './lib/api';
import type { WsMessage, ChatMessage } from './types';

export default function App() {
  const [activeTab, setActiveTab] = useState<'sessions' | 'terminal'>(() => {
    const saved = localStorage.getItem('copilot-remote-active-tab');
    return saved === 'terminal' ? 'terminal' : 'sessions';
  });
  const [activeSessionId, setActiveSessionId] = useState<string | null>(
    () => localStorage.getItem('copilot-remote-active-session')
  );
  const [messages, setMessages] = useState<Map<string, ChatMessage[]>>(new Map());
  const [showNewSession, setShowNewSession] = useState(false);
  const [showSidebar, setShowSidebar] = useState(true);
  // Track streaming text accumulation per session
  const streamBuffers = useRef<Map<string, string>>(new Map());

  const handleWsMessage = useCallback((msg: WsMessage) => {
    if (msg.type === 'message' && msg.sessionId && msg.message) {
      setMessages(prev => {
        const next = new Map(prev);
        const list = next.get(msg.sessionId!) || [];
        const m = msg.message!;
        const isDup = list.some(existing =>
          existing.role === m.role && existing.content === m.content
        );
        if (isDup) return prev;
        next.set(msg.sessionId!, [...list, m]);
        return next;
      });
    } else if (msg.type === 'stream' && msg.sessionId && msg.text) {
      // Accumulate streaming text into a "typing" message
      const sid = msg.sessionId;
      const buf = (streamBuffers.current.get(sid) || '') + msg.text;
      streamBuffers.current.set(sid, buf);
      setMessages(prev => {
        const next = new Map(prev);
        const list = next.get(sid) || [];
        // Update or create the streaming message (last message with id 'streaming-<sid>')
        const streamId = `streaming-${sid}`;
        const streamMsg: ChatMessage = {
          id: streamId,
          role: 'copilot',
          content: buf,
          timestamp: new Date().toISOString(),
        };
        const idx = list.findIndex(m => m.id === streamId);
        if (idx >= 0) {
          const updated = [...list];
          updated[idx] = streamMsg;
          next.set(sid, updated);
        } else {
          next.set(sid, [...list, streamMsg]);
        }
        return next;
      });
    } else if (msg.type === 'turn_complete' && msg.sessionId) {
      // Finalize the streaming message with a stable ID
      const sid = msg.sessionId;
      const buf = streamBuffers.current.get(sid);
      streamBuffers.current.delete(sid);
      if (buf) {
        setMessages(prev => {
          const next = new Map(prev);
          const list = next.get(sid) || [];
          const streamId = `streaming-${sid}`;
          const idx = list.findIndex(m => m.id === streamId);
          if (idx >= 0) {
            const updated = [...list];
            updated[idx] = { ...updated[idx], id: `complete-${Date.now()}` };
            next.set(sid, updated);
          }
          return next;
        });
      }
    }
  }, []);

  const { connected, subscribe, unsubscribe, sendInput } = useWebSocket(handleWsMessage);
  const { sessions, loading, error, refresh, setPaused } = useSessions();

  // Re-subscribe to restored session on mount
  useEffect(() => {
    if (activeSessionId && connected) {
      subscribe(activeSessionId);
    }
  }, [connected]); // eslint-disable-line react-hooks/exhaustive-deps

  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768);

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    localStorage.setItem('copilot-remote-active-tab', activeTab);
  }, [activeTab]);

  const handleSelectSession = useCallback((id: string) => {
    if (activeSessionId) unsubscribe(activeSessionId);
    setActiveSessionId(id);
    localStorage.setItem('copilot-remote-active-session', id);
    subscribe(id);
    if (isMobile) setShowSidebar(false);
  }, [activeSessionId, subscribe, unsubscribe, isMobile]);

  const handleDeleteSession = useCallback(async (id: string) => {
    const confirmed = window.confirm(
      'This will permanently delete the session files from disk (~/.copilot/session-state/).\n\n' +
      'If this session is actively running, the CLI process may error or crash.\n\n' +
      'Continue?'
    );
    if (!confirmed) return;
    try {
      await api.purgeSession(id);
      if (activeSessionId === id) {
        setActiveSessionId(null);
        localStorage.removeItem('copilot-remote-active-session');
      }
      refresh();
    } catch (err) {
      console.error('Purge failed:', err);
    }
  }, [activeSessionId, refresh]);

  // Optimistically add user message to the chat
  const addOptimisticMessage = useCallback((sessionId: string, text: string) => {
    const msg: ChatMessage = {
      id: `opt-${Date.now()}`,
      role: 'user',
      content: text,
      timestamp: new Date().toISOString(),
    };
    setMessages(prev => {
      const next = new Map(prev);
      const list = next.get(sessionId) || [];
      next.set(sessionId, [...list, msg]);
      return next;
    });
  }, []);

  const handleSendMessage = useCallback((text: string) => {
    if (activeSessionId) {
      addOptimisticMessage(activeSessionId, text);
      sendInput(activeSessionId, text);
    }
  }, [activeSessionId, sendInput, addOptimisticMessage]);

  const handleResumeSession = useCallback(async (sessionId: string, prompt?: string) => {
    try {
      if (prompt) addOptimisticMessage(sessionId, prompt);
      const session = await api.createSession({ resume: sessionId, prompt });
      refresh();
      handleSelectSession(session.id);
    } catch (err) {
      console.error('Resume failed:', err);
    }
  }, [refresh, handleSelectSession]);

  const handleNewSession = useCallback(() => {
    setShowNewSession(true);
  }, []);

  const handleSessionCreated = useCallback((id: string) => {
    setShowNewSession(false);
    refresh();
    handleSelectSession(id);
  }, [refresh, handleSelectSession]);

  const isConfigured = !!localStorage.getItem('copilot-remote-token');

  if (!isConfigured) {
    return <ConnectionSetup onComplete={() => window.location.reload()} />;
  }

  const activeSession = sessions.find(s => s.id === activeSessionId);
  const activeMessages = activeSessionId ? (messages.get(activeSessionId) || []) : [];

  return (
    <Box sx={{ height: '100vh', display: 'flex', flexDirection: 'column', bg: 'canvas.default' }}>
      <Box sx={{ px: 3, pt: 2, borderBottom: '1px solid', borderColor: 'border.default' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 2 }}>
          <Text sx={{ fontWeight: 'bold', fontSize: 2, color: 'fg.default' }}>⚡ Copilot Remote</Text>
          <Box sx={{ flex: 1 }} />
          <ConnectionStatus connected={connected} />
        </Box>
        <UnderlineNav aria-label="Main navigation">
          <UnderlineNav.Item
            aria-current={activeTab === 'sessions' ? 'page' : undefined}
            onClick={() => setActiveTab('sessions')}
            icon={CommentDiscussionIcon}
          >
            Sessions
          </UnderlineNav.Item>
          <UnderlineNav.Item
            aria-current={activeTab === 'terminal' ? 'page' : undefined}
            onClick={() => setActiveTab('terminal')}
            icon={TerminalIcon}
          >
            Bidirectional
          </UnderlineNav.Item>
        </UnderlineNav>
      </Box>

      {activeTab === 'sessions' ? (
        <Box sx={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>
          {(!isMobile || showSidebar) && (
            <Box sx={{ width: isMobile ? '100%' : 300, minWidth: isMobile ? undefined : 250, borderRight: isMobile ? 'none' : '1px solid', borderColor: 'border.default', overflowY: 'auto' }}>
              <SessionList
                sessions={sessions}
                loading={loading}
                error={error}
                activeId={activeSessionId}
                onSelect={handleSelectSession}
                onDelete={handleDeleteSession}
                onNew={handleNewSession}
                onRefresh={refresh}
                onEditingChange={setPaused}
              />
            </Box>
          )}
          {(!isMobile || !showSidebar) && (
            <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0 }}>
              {activeSession ? (
                <ChatView
                  session={activeSession}
                  messages={activeMessages}
                  onSend={handleSendMessage}
                  onResume={handleResumeSession}
                  onBack={isMobile ? () => setShowSidebar(true) : undefined}
                />
              ) : (
                <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1 }}>
                  <Text sx={{ color: 'fg.muted', fontSize: 1 }}>Select a session or create a new one</Text>
                </Box>
              )}
            </Box>
          )}
        </Box>
      ) : (
        <Box sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <TerminalView onBack={isMobile ? () => setActiveTab('sessions') : undefined} />
        </Box>
      )}

      {showNewSession && (
        <NewSessionDialog
          onClose={() => setShowNewSession(false)}
          onCreated={handleSessionCreated}
        />
      )}
    </Box>
  );
}

function ConnectionSetup({ onComplete }: { onComplete: () => void }) {
  const [token, setToken] = useState('');
  const [server, setServer] = useState('');

  const handleSave = () => {
    localStorage.setItem('copilot-remote-token', token.trim());
    if (server.trim()) {
      localStorage.setItem('copilot-remote-server', server.trim());
    }
    onComplete();
  };

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', bg: 'canvas.default' }}>
      <Box sx={{ p: 4, maxWidth: 400, width: '100%' }}>
        <Text as="h2" sx={{ mb: 3, color: 'fg.default' }}>⚡ Copilot Remote Setup</Text>
        <Text sx={{ mb: 3, display: 'block', color: 'fg.muted', fontSize: 1 }}>
          Enter the auth token shown when you started the server.
        </Text>
        <Box sx={{ mb: 3 }}>
          <Text as="label" sx={{ display: 'block', mb: 1, fontWeight: 'bold', color: 'fg.default', fontSize: 1 }}>Auth Token</Text>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Paste token here"
            style={{
              width: '100%', padding: '8px 12px', borderRadius: 6,
              border: '1px solid var(--borderColor-default, #30363d)',
              background: 'var(--bgColor-default, #0d1117)',
              color: 'var(--fgColor-default, #e6edf3)',
              fontSize: 14,
            }}
          />
        </Box>
        <Box sx={{ mb: 3 }}>
          <Text as="label" sx={{ display: 'block', mb: 1, fontWeight: 'bold', color: 'fg.default', fontSize: 1 }}>Server URL (optional)</Text>
          <input
            value={server}
            onChange={(e) => setServer(e.target.value)}
            placeholder="http://192.168.x.x:3001"
            style={{
              width: '100%', padding: '8px 12px', borderRadius: 6,
              border: '1px solid var(--borderColor-default, #30363d)',
              background: 'var(--bgColor-default, #0d1117)',
              color: 'var(--fgColor-default, #e6edf3)',
              fontSize: 14,
            }}
          />
        </Box>
        <button
          onClick={handleSave}
          disabled={!token.trim()}
          style={{
            width: '100%', padding: '10px', borderRadius: 6,
            background: token.trim() ? '#238636' : '#21262d',
            color: '#fff', border: 'none', cursor: token.trim() ? 'pointer' : 'default',
            fontWeight: 600, fontSize: 14,
          }}
        >
          Connect
        </button>
      </Box>
    </Box>
  );
}
