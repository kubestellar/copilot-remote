import { useState, useCallback, useEffect } from 'react';
import { Box, Text } from '@primer/react';
import { SessionList } from './components/SessionList';
import { ChatView } from './components/ChatView';
import { ConnectionStatus } from './components/ConnectionStatus';
import { NewSessionDialog } from './components/NewSessionDialog';
import { useWebSocket } from './hooks/useWebSocket';
import { useSessions } from './hooks/useSessions';
import { api } from './lib/api';
import type { WsMessage, ChatMessage } from './types';

export default function App() {
  const [activeSessionId, setActiveSessionId] = useState<string | null>(
    () => localStorage.getItem('copilot-remote-active-session')
  );
  const [messages, setMessages] = useState<Map<string, ChatMessage[]>>(new Map());
  const [showNewSession, setShowNewSession] = useState(false);

  const handleWsMessage = useCallback((msg: WsMessage) => {
    if (msg.type === 'message' && msg.sessionId && msg.message) {
      setMessages(prev => {
        const next = new Map(prev);
        const list = next.get(msg.sessionId!) || [];
        next.set(msg.sessionId!, [...list, msg.message!]);
        return next;
      });
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

  const handleSelectSession = useCallback((id: string) => {
    if (activeSessionId) unsubscribe(activeSessionId);
    setActiveSessionId(id);
    localStorage.setItem('copilot-remote-active-session', id);
    subscribe(id);
  }, [activeSessionId, subscribe, unsubscribe]);

  const handleSendMessage = useCallback((text: string) => {
    if (activeSessionId) {
      sendInput(activeSessionId, text);
    }
  }, [activeSessionId, sendInput]);

  const handleResumeSession = useCallback(async (sessionId: string, prompt?: string) => {
    try {
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
      <Box sx={{ p: 3, borderBottom: '1px solid', borderColor: 'border.default', display: 'flex', alignItems: 'center', gap: 2 }}>
        <Text sx={{ fontWeight: 'bold', fontSize: 2, color: 'fg.default' }}>⚡ Copilot Remote</Text>
        <Box sx={{ flex: 1 }} />
        <ConnectionStatus connected={connected} />
      </Box>

      <Box sx={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>
        <Box sx={{ width: 300, minWidth: 250, borderRight: '1px solid', borderColor: 'border.default', overflowY: 'auto' }}>
          <SessionList
            sessions={sessions}
            loading={loading}
            error={error}
            activeId={activeSessionId}
            onSelect={handleSelectSession}
            onNew={handleNewSession}
            onRefresh={refresh}
            onEditingChange={setPaused}
          />
        </Box>
        <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0 }}>
          {activeSession ? (
            <ChatView
              session={activeSession}
              messages={activeMessages}
              onSend={handleSendMessage}
              onResume={handleResumeSession}
            />
          ) : (
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1 }}>
              <Text sx={{ color: 'fg.muted', fontSize: 1 }}>Select a session or create a new one</Text>
            </Box>
          )}
        </Box>
      </Box>

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
