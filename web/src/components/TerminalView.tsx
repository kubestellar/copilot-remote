import { useEffect, useRef, useCallback, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Box, IconButton, Text } from '@primer/react';
import { PlusIcon, TrashIcon, ArrowLeftIcon } from '@primer/octicons-react';
import '@xterm/xterm/css/xterm.css';

interface Props {
  onBack?: () => void;
}

export function TerminalView({ onBack }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const [termId, setTermId] = useState<string | null>(null);
  const [tmuxSession, setTmuxSession] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  const connect = useCallback((id: string) => {
    // Clean up existing
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    if (termRef.current) {
      termRef.current.dispose();
      termRef.current = null;
    }

    const token = localStorage.getItem('copilot-remote-token') || '';
    const serverUrl = localStorage.getItem('copilot-remote-server') || `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.hostname}:3001`;
    const wsUrl = serverUrl.replace(/^http/, 'ws');

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: '"Cascadia Code", "Fira Code", "SF Mono", monospace',
      theme: {
        background: '#0d1117',
        foreground: '#e6edf3',
        cursor: '#58a6ff',
        cursorAccent: '#0d1117',
        selectionBackground: '#264f78',
        black: '#484f58',
        red: '#ff7b72',
        green: '#3fb950',
        yellow: '#d29922',
        blue: '#58a6ff',
        magenta: '#bc8cff',
        cyan: '#39d353',
        white: '#b1bac4',
        brightBlack: '#6e7681',
        brightRed: '#ffa198',
        brightGreen: '#56d364',
        brightYellow: '#e3b341',
        brightBlue: '#79c0ff',
        brightMagenta: '#d2a8ff',
        brightCyan: '#56d364',
        brightWhite: '#f0f6fc',
      },
      allowTransparency: true,
      scrollback: 5000,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);

    termRef.current = term;
    fitAddonRef.current = fitAddon;

    if (containerRef.current) {
      containerRef.current.innerHTML = '';
      term.open(containerRef.current);
      setTimeout(() => fitAddon.fit(), 50);
    }

    const ws = new WebSocket(`${wsUrl}/ws/terminal?token=${token}&id=${id}`);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      // Send initial size
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    };

    ws.onmessage = (e) => {
      term.write(e.data);
    };

    ws.onclose = () => {
      setConnected(false);
      term.write('\r\n\x1b[33m[Disconnected]\x1b[0m\r\n');
    };

    // Forward keystrokes to server
    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });

    // Forward resize
    term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols, rows }));
      }
    });
  }, []);

  // Create a terminal on mount
  useEffect(() => {
    const token = localStorage.getItem('copilot-remote-token') || '';
    const serverUrl = localStorage.getItem('copilot-remote-server') || `${window.location.protocol}//${window.location.hostname}:3001`;

    fetch(`${serverUrl}/api/terminals`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
      .then(r => r.json())
      .then(data => {
        setTermId(data.id);
        setTmuxSession(data.tmuxSession || null);
        connect(data.id);
      })
      .catch(err => console.error('Failed to create terminal:', err));

    return () => {
      wsRef.current?.close();
      termRef.current?.dispose();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle window resize
  useEffect(() => {
    const handleResize = () => {
      if (fitAddonRef.current) {
        try { fitAddonRef.current.fit(); } catch {}
      }
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const handleNewTerminal = useCallback(() => {
    const token = localStorage.getItem('copilot-remote-token') || '';
    const serverUrl = localStorage.getItem('copilot-remote-server') || `${window.location.protocol}//${window.location.hostname}:3001`;

    fetch(`${serverUrl}/api/terminals`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
      .then(r => r.json())
      .then(data => {
        if (termId) {
          // Destroy old terminal
          fetch(`${serverUrl}/api/terminals/${termId}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` },
          }).catch(() => {});
        }
        setTermId(data.id);
        setTmuxSession(data.tmuxSession || null);
        connect(data.id);
      })
      .catch(err => console.error('Failed to create terminal:', err));
  }, [termId, connect]);

  const handleDestroyTerminal = useCallback(() => {
    if (!termId) return;
    const token = localStorage.getItem('copilot-remote-token') || '';
    const serverUrl = localStorage.getItem('copilot-remote-server') || `${window.location.protocol}//${window.location.hostname}:3001`;

    fetch(`${serverUrl}/api/terminals/${termId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` },
    }).catch(() => {});

    wsRef.current?.close();
    termRef.current?.dispose();
    termRef.current = null;
    setTermId(null);
    setConnected(false);
  }, [termId]);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <Box sx={{
        px: 3, py: 2,
        borderBottom: '1px solid', borderColor: 'border.default',
        display: 'flex', alignItems: 'center', gap: 2,
      }}>
        {onBack && (
          <IconButton
            icon={ArrowLeftIcon}
            aria-label="Back"
            variant="invisible"
            size="small"
            onClick={onBack}
          />
        )}
        <Text sx={{ fontWeight: 'bold', fontSize: 1, color: 'fg.default' }}>
          Terminal
        </Text>
        <Box sx={{
          width: 8, height: 8, borderRadius: '50%',
          bg: connected ? 'success.fg' : 'danger.fg',
        }} />
        {tmuxSession ? (
          <Text sx={{ fontSize: 0, color: 'fg.muted', fontFamily: 'mono' }}>
            tmux attach -t {tmuxSession}
          </Text>
        ) : termId ? (
          <Text sx={{ fontSize: 0, color: 'fg.muted', fontFamily: 'mono' }}>
            {termId}
          </Text>
        ) : null}
        <Box sx={{ flex: 1 }} />
        <IconButton
          icon={PlusIcon}
          aria-label="New terminal"
          variant="invisible"
          size="small"
          onClick={handleNewTerminal}
        />
        <IconButton
          icon={TrashIcon}
          aria-label="Close terminal"
          variant="invisible"
          size="small"
          onClick={handleDestroyTerminal}
        />
      </Box>

      {/* Terminal container */}
      <Box
        ref={containerRef}
        sx={{
          flex: 1,
          minHeight: 0,
          p: 1,
          bg: '#0d1117',
          '& .xterm': { height: '100%' },
          '& .xterm-viewport': { overflow: 'hidden !important' },
        }}
      />
    </Box>
  );
}
