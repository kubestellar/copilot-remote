import { useState, useEffect, useCallback, useRef } from 'react';
import { Box, Text, Flash } from '@primer/react';

/** Interval for polling the todo queue (ms) */
const SWARM_POLL_INTERVAL_MS = 3_000;

/** Session storage key for the swarm key */
const SWARM_KEY_SESSION_STORAGE_KEY = 'copilot-remote-swarm-key';

/** Maximum characters allowed in the todo input */
const SWARM_INPUT_MAX_LENGTH = 500;

/** Status dot colors */
const STATUS_COLORS: Record<string, string> = {
  pending: '#6e7681',
  running: '#d29922',
  done: '#3fb950',
  failed: '#f85149',
};

interface SwarmTodoItem {
  id: string;
  description: string;
  status: string;
  createdAt: string;
  assignedTileName: string | null;
}

type ConnectionState = 'connecting' | 'connected' | 'invalid-key' | 'disabled' | 'error';

export default function SwarmApp() {
  const [items, setItems] = useState<SwarmTodoItem[]>([]);
  const [todoMode, setTodoMode] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Extract swarm key from URL or session storage
  const getSwarmKey = useCallback((): string | null => {
    const params = new URLSearchParams(window.location.search);
    const urlKey = params.get('key');
    if (urlKey) {
      sessionStorage.setItem(SWARM_KEY_SESSION_STORAGE_KEY, urlKey);
      return urlKey;
    }
    return sessionStorage.getItem(SWARM_KEY_SESSION_STORAGE_KEY);
  }, []);

  const swarmKey = getSwarmKey();

  // Build API URL (relative for same-origin, or use stored server URL)
  const getBaseUrl = useCallback(() => '', []);

  const fetchTodos = useCallback(async () => {
    if (!swarmKey) {
      setConnectionState('invalid-key');
      return;
    }

    try {
      const res = await fetch(`${getBaseUrl()}/swarm/api/todos`, {
        headers: { Authorization: `Bearer ${swarmKey}` },
      });

      if (res.status === 401 || res.status === 403) {
        setConnectionState('invalid-key');
        return;
      }
      if (res.status === 503) {
        setConnectionState('disabled');
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error || `HTTP ${res.status}`);
        setConnectionState('error');
        return;
      }

      const data = await res.json();
      setItems(data.items || []);
      setTodoMode(data.todoMode ?? false);
      setConnectionState('connected');
      setError(null);
    } catch (err) {
      setConnectionState('error');
      setError('Cannot reach server');
    }
  }, [swarmKey, getBaseUrl]);

  // Poll for updates
  useEffect(() => {
    fetchTodos();
    const interval = setInterval(fetchTodos, SWARM_POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchTodos]);

  const handleSubmit = useCallback(async () => {
    const trimmed = inputValue.trim();
    if (!trimmed || !swarmKey) return;

    setSubmitError(null);

    try {
      const res = await fetch(`${getBaseUrl()}/swarm/api/todos`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${swarmKey}`,
        },
        body: JSON.stringify({ description: trimmed }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setSubmitError(body.error || `HTTP ${res.status}`);
        return;
      }

      setInputValue('');
      // Immediately refresh the list
      fetchTodos();
    } catch (err) {
      setSubmitError('Failed to submit');
    }
  }, [inputValue, swarmKey, getBaseUrl, fetchTodos]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSubmit();
    }
  }, [handleSubmit]);

  const pendingCount = items.filter(i => i.status === 'pending').length;
  const runningCount = items.filter(i => i.status === 'running').length;
  const doneCount = items.filter(i => i.status === 'done').length;

  return (
    <Box sx={{ maxWidth: 600, mx: 'auto', p: 3, minHeight: '100vh' }}>
      {/* Header */}
      <Box sx={{ mb: 3, textAlign: 'center' }}>
        <Text as="h1" sx={{ fontSize: 4, fontWeight: 'bold', color: 'fg.default', m: 0 }}>
          Copilot Remote — Swarm
        </Text>
        <Text sx={{ fontSize: 1, color: 'fg.muted', display: 'block', mt: 1 }}>
          Submit tasks to the shared queue
        </Text>
      </Box>

      {/* Connection status */}
      <Box sx={{ mb: 3 }}>
        {connectionState === 'connecting' && (
          <Flash variant="default">Connecting...</Flash>
        )}
        {connectionState === 'invalid-key' && (
          <Flash variant="danger">Invalid or missing swarm key. Check your invite link.</Flash>
        )}
        {connectionState === 'disabled' && (
          <Flash variant="warning">Swarm mode is currently disabled by the owner.</Flash>
        )}
        {connectionState === 'error' && error && (
          <Flash variant="danger">{error}</Flash>
        )}
        {connectionState === 'connected' && (
          <Flash variant="success" sx={{ py: 1 }}>
            Connected {todoMode ? '— Auto-dispatch ON' : '— Auto-dispatch OFF'}
          </Flash>
        )}
      </Box>

      {/* Input */}
      {connectionState === 'connected' && (
        <Box sx={{ mb: 3 }}>
          <Box sx={{ display: 'flex', gap: 2 }}>
            <input
              ref={inputRef}
              type="text"
              placeholder="Enter a command to add to the queue..."
              value={inputValue}
              onChange={e => setInputValue(e.target.value.slice(0, SWARM_INPUT_MAX_LENGTH))}
              onKeyDown={handleKeyDown}
              style={{
                flex: 1,
                padding: '8px 12px',
                borderRadius: 6,
                border: '1px solid var(--borderColor-default, #30363d)',
                background: 'var(--bgColor-default, #0d1117)',
                color: 'var(--fgColor-default, #e6edf3)',
                fontSize: 14,
                fontFamily: 'monospace',
                outline: 'none',
              }}
            />
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!inputValue.trim()}
              style={{
                padding: '8px 16px',
                borderRadius: 6,
                border: 'none',
                background: inputValue.trim() ? '#238636' : '#21262d',
                color: inputValue.trim() ? '#ffffff' : '#484f58',
                fontSize: 14,
                fontWeight: 600,
                cursor: inputValue.trim() ? 'pointer' : 'default',
              }}
            >
              Add
            </button>
          </Box>
          <Text sx={{ fontSize: '11px', color: 'fg.muted', mt: 1, display: 'block' }}>
            {inputValue.length}/{SWARM_INPUT_MAX_LENGTH} — Press Enter to submit
          </Text>
          {submitError && (
            <Flash variant="danger" sx={{ mt: 2, py: 1, fontSize: '12px' }}>
              {submitError}
            </Flash>
          )}
        </Box>
      )}

      {/* Queue stats */}
      {connectionState === 'connected' && items.length > 0 && (
        <Box sx={{ mb: 2, display: 'flex', gap: 3 }}>
          <Text sx={{ fontSize: '12px', color: 'fg.muted', fontFamily: 'mono' }}>
            {pendingCount} pending
          </Text>
          <Text sx={{ fontSize: '12px', color: 'attention.fg', fontFamily: 'mono' }}>
            {runningCount} running
          </Text>
          <Text sx={{ fontSize: '12px', color: 'success.fg', fontFamily: 'mono' }}>
            {doneCount} done
          </Text>
        </Box>
      )}

      {/* Queue list */}
      {connectionState === 'connected' && (
        <Box sx={{ borderRadius: 2, border: '1px solid', borderColor: 'border.default', overflow: 'hidden' }}>
          {items.length === 0 ? (
            <Box sx={{ p: 4, textAlign: 'center' }}>
              <Text sx={{ fontSize: '13px', color: 'fg.muted', fontStyle: 'italic' }}>
                Queue is empty — add a command above
              </Text>
            </Box>
          ) : (
            items.map((item, idx) => (
              <Box
                key={item.id}
                sx={{
                  px: 3,
                  py: 2,
                  borderBottom: idx < items.length - 1 ? '1px solid' : 'none',
                  borderColor: 'border.muted',
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 2,
                  bg: item.status === 'running' ? 'attention.subtle' : 'canvas.default',
                }}
              >
                {/* Status dot */}
                <span
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: '50%',
                    background: STATUS_COLORS[item.status] || '#6e7681',
                    flexShrink: 0,
                    marginTop: 4,
                  }}
                />
                {/* Content */}
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Text
                    sx={{
                      fontSize: '13px',
                      fontFamily: 'mono',
                      color: item.status === 'done' ? 'fg.muted' : 'fg.default',
                      textDecoration: item.status === 'done' ? 'line-through' : 'none',
                      wordBreak: 'break-all',
                      display: 'block',
                    }}
                  >
                    {item.description}
                  </Text>
                  {item.status === 'running' && item.assignedTileName && (
                    <Text sx={{ fontSize: '11px', color: 'attention.fg', mt: 1, display: 'block' }}>
                      Running on: {item.assignedTileName}
                    </Text>
                  )}
                </Box>
                {/* Status label */}
                <Text sx={{ fontSize: '11px', color: 'fg.muted', flexShrink: 0, textTransform: 'capitalize' }}>
                  {item.status}
                </Text>
              </Box>
            ))
          )}
        </Box>
      )}
    </Box>
  );
}
