import { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { Box, IconButton, Text, Label, Button } from '@primer/react';
import { PaperAirplaneIcon, SquareIcon, PlayIcon, ChevronLeftIcon } from '@primer/octicons-react';
import { MessageBubble } from './MessageBubble';
import { api } from '../lib/api';
import type { Session, ChatMessage } from '../types';

interface Props {
  session: Session;
  messages: ChatMessage[];
  onSend: (text: string) => void;
  onResume: (sessionId: string, prompt?: string) => void;
  onBack?: () => void;
}

export function ChatView({ session, messages, onSend, onResume, onBack }: Props) {
  const [input, setInput] = useState('');
  const [historicalMessages, setHistoricalMessages] = useState<ChatMessage[]>([]);
  const [resuming, setResuming] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Load historical messages when session changes
  useEffect(() => {
    api.getSession(session.id)
      .then(data => setHistoricalMessages(data.messages || []))
      .catch(() => setHistoricalMessages([]));
  }, [session.id]);

  // Auto-scroll to bottom on new messages
  // Deduplicate by ID — live messages override historical ones with the same ID
  const allMessages = useMemo(() => {
    const seen = new Set<string>();
    const merged: ChatMessage[] = [];
    // Add live messages first (they take priority)
    for (const m of messages) { seen.add(m.id); merged.push(m); }
    // Prepend historical messages not already in live set
    const historical: ChatMessage[] = [];
    for (const m of historicalMessages) { if (!seen.has(m.id)) { seen.add(m.id); historical.push(m); } }
    return [...historical, ...merged];
  }, [historicalMessages, messages]);
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [allMessages.length]);

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text) return;
    // Always send via WebSocket — server tries ACP first, falls back to PTY
    onSend(text);
    setInput('');
  }, [input, onSend]);

  const handleResume = useCallback(() => {
    setResuming(true);
    onResume(session.id);
  }, [onResume, session.id]);

  useEffect(() => {
    if (session.status === 'running') setResuming(false);
  }, [session.status]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  const handleKill = useCallback(async () => {
    try {
      await api.killSession(session.id);
    } catch {
      // Ignore
    }
  }, [session.id]);

  const isRunning = session.status === 'running';
  const isActive = session.status === 'active';
  const isLive = isRunning || isActive;
  const placeholder = isRunning
    ? 'Send a message...'
    : isActive
    ? 'This session is active in a terminal. Type to resume a copy...'
    : 'Type a message to resume this session...';

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, position: 'relative' }}>
      {/* Session header */}
      <Box sx={{ p: 2, borderBottom: '1px solid', borderColor: 'border.default', display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
        {onBack && (
          <IconButton
            icon={ChevronLeftIcon}
            aria-label="Back to sessions"
            variant="invisible"
            size="small"
            onClick={onBack}
          />
        )}
        <Box sx={{ flex: 1, overflow: 'hidden' }}>
          <Text sx={{ fontWeight: 'bold', fontSize: 2, color: '#e6edf3', display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {session.name || session.summary || session.id.slice(0, 12)}
          </Text>
          <Text sx={{ color: '#8b949e', fontSize: 0 }}>{session.cwd}</Text>
          <Text sx={{ color: '#6e7681', fontSize: 0, fontFamily: 'mono' }}>{session.id}</Text>
        </Box>
        <Label variant={isLive ? 'success' : 'secondary'}>
          {isRunning ? 'running' : isActive ? 'active' : 'ended'}
        </Label>
        {isRunning ? (
          <IconButton
            icon={SquareIcon}
            aria-label="Stop session"
            variant="danger"
            size="small"
            onClick={handleKill}
          />
        ) : (
          <Button
            leadingVisual={PlayIcon}
            size="small"
            variant="primary"
            onClick={handleResume}
            disabled={resuming}
          >
            {resuming ? 'Resuming...' : 'Resume'}
          </Button>
        )}
      </Box>

      {/* Messages area */}
      <Box
        ref={scrollRef}
        sx={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          WebkitOverflowScrolling: 'touch',
          py: 3,
        }}
      >
        {allMessages.length === 0 && (
          <Box sx={{ textAlign: 'center', py: 6 }}>
            <Text sx={{ color: 'fg.muted', fontSize: 1 }}>
              {isRunning ? 'Waiting for output...' : 'No messages in this session'}
            </Text>
          </Box>
        )}
        {allMessages.map(msg => (
          <MessageBubble key={msg.id} message={msg} />
        ))}
      </Box>

      {/* Input area — iMessage style */}
      <Box sx={{
        px: 3,
        pt: 2,
        pb: 4,
        borderTop: '1px solid',
        borderColor: 'border.default',
        flexShrink: 0,
        bg: 'canvas.subtle',
      }}>
        <Box sx={{
          display: 'flex',
          gap: 2,
          alignItems: 'flex-end',
        }}>
          <Box sx={{
            flex: 1,
            bg: 'canvas.default',
            borderRadius: '20px',
            border: '1px solid',
            borderColor: 'border.default',
            px: 3,
            py: '6px',
            display: 'flex',
            alignItems: 'center',
          }}>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              style={{
                width: '100%',
                background: 'transparent',
                border: 'none',
                outline: 'none',
                color: '#e6edf3',
                fontSize: 14,
                lineHeight: '20px',
              }}
            />
          </Box>
          <IconButton
            icon={PaperAirplaneIcon}
            aria-label="Send"
            variant="primary"
            onClick={handleSend}
            disabled={!input.trim()}
            sx={{ borderRadius: '50%', width: 36, height: 36, flexShrink: 0 }}
          />
        </Box>
      </Box>
    </Box>
  );
}
