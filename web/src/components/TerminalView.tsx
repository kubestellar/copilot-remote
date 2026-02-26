import { useEffect, useRef, useCallback, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Box, IconButton, Text, ActionMenu, ActionList } from '@primer/react';
import { PlusIcon, XIcon, ArrowLeftIcon, ColumnsIcon, LinkIcon } from '@primer/octicons-react';
import '@xterm/xterm/css/xterm.css';

interface TermTab {
  id: string;
  tmuxSession: string;
  name: string;
  checked: boolean;
}

// Mutable refs for each terminal's xterm + ws (not in React state to avoid re-renders)
const termInstances = new Map<string, {
  term: Terminal;
  fitAddon: FitAddon;
  ws: WebSocket;
  connected: boolean;
  container: HTMLDivElement | null;
}>();

function getServerUrls() {
  const token = localStorage.getItem('copilot-remote-token') || '';
  const serverUrl = localStorage.getItem('copilot-remote-server') || `${window.location.protocol}//${window.location.hostname}:3001`;
  const wsUrl = serverUrl.replace(/^http/, 'ws');
  return { token, serverUrl, wsUrl };
}

const TERM_OPTS: ConstructorParameters<typeof Terminal>[0] = {
  cursorBlink: true,
  fontSize: 14,
  fontFamily: '"Cascadia Code", "Fira Code", "SF Mono", monospace',
  theme: {
    background: '#0d1117',
    foreground: '#e6edf3',
    cursor: '#58a6ff',
    cursorAccent: '#0d1117',
    selectionBackground: '#264f78',
    black: '#484f58', red: '#ff7b72', green: '#3fb950', yellow: '#d29922',
    blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39d353', white: '#b1bac4',
    brightBlack: '#6e7681', brightRed: '#ffa198', brightGreen: '#56d364',
    brightYellow: '#e3b341', brightBlue: '#79c0ff', brightMagenta: '#d2a8ff',
    brightCyan: '#56d364', brightWhite: '#f0f6fc',
  },
  allowTransparency: true,
  scrollback: 5000,
};

interface Props {
  onBack?: () => void;
}

export function TerminalView({ onBack }: Props) {
  const [tabs, setTabs] = useState<TermTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [tileMode, setTileMode] = useState(false);
  const singleRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  const createTermConnection = useCallback((tabId: string, container: HTMLDivElement) => {
    // Clean up if exists
    const existing = termInstances.get(tabId);
    if (existing) {
      existing.ws?.close();
      existing.term?.dispose();
      termInstances.delete(tabId);
    }

    const { token, wsUrl } = getServerUrls();
    const term = new Terminal(TERM_OPTS);
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());

    container.innerHTML = '';
    term.open(container);
    setTimeout(() => { try { fitAddon.fit(); } catch {} }, 50);

    const ws = new WebSocket(`${wsUrl}/ws/terminal?token=${token}&id=${tabId}`);
    const inst = { term, fitAddon, ws, connected: false, container };
    termInstances.set(tabId, inst);

    ws.onopen = () => {
      inst.connected = true;
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      setTabs(prev => [...prev]); // trigger re-render for status dot
    };

    ws.onmessage = (e) => {
      try {
        const parsed = JSON.parse(e.data);
        if (parsed.type === 'command') {
          setTabs(prev => prev.map(t => t.id === parsed.id ? { ...t, name: parsed.command } : t));
          return;
        }
      } catch { /* raw terminal data */ }
      term.write(e.data);
    };

    ws.onclose = () => {
      inst.connected = false;
      term.write('\r\n\x1b[33m[Disconnected]\x1b[0m\r\n');
      setTabs(prev => [...prev]);
    };

    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    });

    term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    });
  }, []);

  const addTab = useCallback(async () => {
    const { token, serverUrl } = getServerUrls();
    try {
      const res = await fetch(`${serverUrl}/api/terminals`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      const newTab: TermTab = {
        id: data.id,
        tmuxSession: data.tmuxSession || '',
        name: `Terminal ${tabsRef.current.length + 1}`,
        checked: false,
      };
      setTabs(prev => [...prev, newTab]);
      setActiveTabId(data.id);
    } catch (err) {
      console.error('Failed to create terminal:', err);
    }
  }, []);

  const [tmuxSessions, setTmuxSessions] = useState<string[]>([]);

  const fetchTmuxSessions = useCallback(async () => {
    const { token, serverUrl } = getServerUrls();
    try {
      const res = await fetch(`${serverUrl}/api/tmux-sessions`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const data = await res.json();
      // Filter out sessions already attached in our tabs
      const attached = new Set(tabsRef.current.map(t => t.tmuxSession));
      setTmuxSessions((data as string[]).filter(s => !attached.has(s)));
    } catch (err) {
      console.error('Failed to fetch tmux sessions:', err);
      setTmuxSessions([]);
    }
  }, []);

  const attachTab = useCallback(async (tmuxSession: string) => {
    const { token, serverUrl } = getServerUrls();
    try {
      const res = await fetch(`${serverUrl}/api/terminals/attach`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ tmuxSession }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      const newTab: TermTab = {
        id: data.id,
        tmuxSession: data.tmuxSession || tmuxSession,
        name: tmuxSession,
        checked: false,
      };
      setTabs(prev => [...prev, newTab]);
      setActiveTabId(data.id);
    } catch (err) {
      console.error('Failed to attach tmux session:', err);
    }
  }, []);

  const closeTab = useCallback((id: string) => {
    const { token, serverUrl } = getServerUrls();
    const inst = termInstances.get(id);
    if (inst) {
      inst.ws?.close();
      inst.term?.dispose();
      termInstances.delete(id);
    }
    fetch(`${serverUrl}/api/terminals/${id}`, {
      method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` },
    }).catch(() => {});
    setTabs(prev => {
      const next = prev.filter(t => t.id !== id);
      if (activeTabId === id) {
        setActiveTabId(next.length > 0 ? next[next.length - 1].id : null);
      }
      return next;
    });
  }, [activeTabId]);

  const toggleCheck = useCallback((id: string) => {
    setTabs(prev => prev.map(t => t.id === id ? { ...t, checked: !t.checked } : t));
  }, []);

  // Create first tab on mount
  useEffect(() => {
    addTab();
    return () => {
      for (const [, inst] of termInstances) {
        inst.ws?.close();
        inst.term?.dispose();
      }
      termInstances.clear();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Mount active terminal to single container (non-tile mode)
  useEffect(() => {
    if (tileMode || !activeTabId || !singleRef.current) return;
    const inst = termInstances.get(activeTabId);
    if (inst && inst.container === singleRef.current) {
      // Already mounted here — just refit
      setTimeout(() => { try { inst.fitAddon.fit(); } catch {} }, 50);
      return;
    }
    if (inst) {
      // Re-mount existing terminal
      singleRef.current.innerHTML = '';
      inst.term.open(singleRef.current);
      inst.container = singleRef.current;
      setTimeout(() => { try { inst.fitAddon.fit(); } catch {} }, 50);
      inst.term.focus();
    } else if (tabs.find(t => t.id === activeTabId)) {
      // New terminal — connect
      createTermConnection(activeTabId, singleRef.current);
    }
  }, [activeTabId, tileMode, tabs.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle window resize
  useEffect(() => {
    const handleResize = () => {
      if (tileMode) {
        for (const [, inst] of termInstances) {
          try { inst.fitAddon.fit(); } catch {}
        }
      } else {
        const inst = activeTabId ? termInstances.get(activeTabId) : null;
        if (inst) try { inst.fitAddon.fit(); } catch {}
      }
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [activeTabId, tileMode]);

  const checkedTabs = tabs.filter(t => t.checked);
  const hasChecked = checkedTabs.length > 0;

  // Tile ref callback — mount terminal into tile container
  const tileRefCallback = useCallback((el: HTMLDivElement | null, tabId: string) => {
    if (!el || !tileMode) return;
    const inst = termInstances.get(tabId);
    if (inst) {
      if (inst.container !== el) {
        el.innerHTML = '';
        inst.term.open(el);
        inst.container = el;
      }
      setTimeout(() => { try { inst.fitAddon.fit(); } catch {} }, 100);
    } else {
      createTermConnection(tabId, el);
    }
  }, [tileMode, createTermConnection]);

  // Refit tiles when entering tile mode
  useEffect(() => {
    if (!tileMode) return;
    const timer = setTimeout(() => {
      for (const tab of checkedTabs) {
        const inst = termInstances.get(tab.id);
        if (inst) try { inst.fitAddon.fit(); } catch {}
      }
    }, 150);
    return () => clearTimeout(timer);
  }, [tileMode, checkedTabs.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const tileCols = checkedTabs.length <= 2 ? checkedTabs.length : checkedTabs.length <= 4 ? 2 : 3;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Tab bar */}
      <Box sx={{
        display: 'flex', alignItems: 'center',
        borderBottom: '1px solid', borderColor: 'border.default',
        bg: 'canvas.subtle', minHeight: '36px',
      }}>
        {onBack && (
          <IconButton icon={ArrowLeftIcon} aria-label="Back" variant="invisible" size="small" sx={{ mx: 1 }} onClick={onBack} />
        )}
        <Box sx={{ display: 'flex', flex: 1, overflow: 'auto', minWidth: 0 }}>
          {tabs.map(tab => {
            const inst = termInstances.get(tab.id);
            const isConnected = inst?.connected ?? false;
            return (
              <Box
                key={tab.id}
                sx={{
                  display: 'flex', alignItems: 'center', gap: 1,
                  px: 2, py: '5px',
                  cursor: 'pointer',
                  borderRight: '1px solid', borderColor: 'border.muted',
                  bg: !tileMode && tab.id === activeTabId ? 'canvas.default' : 'transparent',
                  borderBottom: !tileMode && tab.id === activeTabId ? '2px solid' : '2px solid transparent',
                  borderBottomColor: !tileMode && tab.id === activeTabId ? 'accent.fg' : 'transparent',
                  ':hover': { bg: 'canvas.default' },
                  maxWidth: 200, flexShrink: 0,
                }}
              >
                <input
                  type="checkbox"
                  checked={tab.checked}
                  onChange={() => toggleCheck(tab.id)}
                  onClick={e => e.stopPropagation()}
                  style={{ margin: 0, cursor: 'pointer' }}
                />
                <Box
                  onClick={() => { if (!tileMode) setActiveTabId(tab.id); }}
                  sx={{ display: 'flex', alignItems: 'center', gap: 1, flex: 1, overflow: 'hidden' }}
                >
                  <Box sx={{ width: 6, height: 6, borderRadius: '50%', flexShrink: 0, bg: isConnected ? 'success.fg' : 'danger.fg' }} />
                  <Text sx={{ fontSize: '11px', color: 'fg.default', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'mono' }}>
                    {tab.name}
                  </Text>
                </Box>
                <Box
                  as="button"
                  onClick={(e: React.MouseEvent) => { e.stopPropagation(); closeTab(tab.id); }}
                  sx={{ bg: 'transparent', border: 'none', color: 'fg.muted', cursor: 'pointer', p: 0, display: 'flex', flexShrink: 0, ':hover': { color: 'danger.fg' } }}
                >
                  <XIcon size={12} />
                </Box>
              </Box>
            );
          })}
        </Box>
        {hasChecked && (
          <IconButton
            icon={ColumnsIcon}
            aria-label={tileMode ? 'Single view' : 'Tile checked terminals'}
            variant={tileMode ? 'primary' : 'invisible'}
            size="small"
            sx={{ mx: 1, flexShrink: 0 }}
            onClick={() => setTileMode(!tileMode)}
          />
        )}
        <ActionMenu>
          <ActionMenu.Anchor>
            <IconButton icon={LinkIcon} aria-label="Attach tmux session" variant="invisible" size="small" sx={{ flexShrink: 0 }} onClick={fetchTmuxSessions} />
          </ActionMenu.Anchor>
          <ActionMenu.Overlay>
            <ActionList>
              <ActionList.GroupHeading as="h3">Attach tmux session</ActionList.GroupHeading>
              {tmuxSessions.length === 0 ? (
                <ActionList.Item disabled>No sessions found</ActionList.Item>
              ) : (
                tmuxSessions.map(s => (
                  <ActionList.Item key={s} onSelect={() => attachTab(s)}>
                    <ActionList.LeadingVisual><Text sx={{ fontFamily: 'mono', fontSize: '11px' }}>⬡</Text></ActionList.LeadingVisual>
                    {s}
                  </ActionList.Item>
                ))
              )}
            </ActionList>
          </ActionMenu.Overlay>
        </ActionMenu>
        <IconButton icon={PlusIcon} aria-label="New terminal" variant="invisible" size="small" sx={{ mx: 1, flexShrink: 0 }} onClick={addTab} />
      </Box>

      {/* Terminal area */}
      {tileMode && hasChecked ? (
        /* Tile grid */
        <Box sx={{
          flex: 1, minHeight: 0, display: 'grid',
          gridTemplateColumns: `repeat(${tileCols}, 1fr)`,
          gap: '1px', bg: 'border.default',
        }}>
          {checkedTabs.map(tab => (
            <Box key={tab.id} sx={{ display: 'flex', flexDirection: 'column', bg: '#0d1117', minHeight: 0, overflow: 'hidden' }}>
              <Box sx={{ px: 2, py: '3px', bg: 'canvas.subtle', borderBottom: '1px solid', borderColor: 'border.muted', display: 'flex', alignItems: 'center', gap: 1 }}>
                <Box sx={{ width: 6, height: 6, borderRadius: '50%', bg: termInstances.get(tab.id)?.connected ? 'success.fg' : 'danger.fg' }} />
                <Text sx={{ fontSize: '10px', fontFamily: 'mono', color: 'fg.muted', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {tab.name}
                </Text>
                {tab.tmuxSession && (
                  <Text sx={{ fontSize: '9px', color: 'fg.subtle', fontFamily: 'mono', ml: 'auto', flexShrink: 0 }}>
                    {tab.tmuxSession}
                  </Text>
                )}
              </Box>
              <Box
                ref={(el: HTMLDivElement | null) => tileRefCallback(el, tab.id)}
                sx={{ flex: 1, minHeight: 0, '& .xterm': { height: '100%' }, '& .xterm-viewport': { overflow: 'hidden !important' } }}
              />
            </Box>
          ))}
        </Box>
      ) : (
        /* Single terminal */
        <Box
          ref={singleRef}
          sx={{
            flex: 1, minHeight: 0, p: 1, bg: '#0d1117',
            '& .xterm': { height: '100%' },
            '& .xterm-viewport': { overflow: 'hidden !important' },
          }}
        />
      )}
    </Box>
  );
}
