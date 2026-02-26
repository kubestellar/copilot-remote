import { useEffect, useRef, useCallback, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Box, IconButton, Text, ActionMenu, ActionList } from '@primer/react';
import { PlusIcon, XIcon, ArrowLeftIcon, AppsIcon, LinkIcon } from '@primer/octicons-react';
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
  reconnectAttempts: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
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
  fontFamily: '"MesloLGS NF", "Cascadia Code", "Fira Code", "SF Mono", monospace',
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
  const [fontReady, setFontReady] = useState(false);
  const singleRef = useRef<HTMLDivElement>(null);
  const tileContainerRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  // Preload terminal font before creating any xterm instances
  useEffect(() => {
    document.fonts.load('14px "MesloLGS NF"').then(() => {
      setFontReady(true);
    }).catch(() => {
      // Font not available — proceed with fallback
      setFontReady(true);
    });
  }, []);

  const createTermConnection = useCallback((tabId: string, container: HTMLDivElement, fontSize?: number) => {
    // Clean up if exists
    const existing = termInstances.get(tabId);
    if (existing) {
      if (existing.reconnectTimer) clearTimeout(existing.reconnectTimer);
      existing.ws?.close();
      existing.term?.dispose();
      termInstances.delete(tabId);
    }

    const { token, wsUrl } = getServerUrls();
    const term = new Terminal({ ...TERM_OPTS, fontSize: fontSize ?? TERM_OPTS.fontSize });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());

    container.innerHTML = '';
    term.open(container);
    setTimeout(() => {
      try { fitAddon.fit(); } catch {}
    }, 50);

    const ws = new WebSocket(`${wsUrl}/ws/terminal?token=${token}&id=${tabId}`);
    const inst = { term, fitAddon, ws, connected: false, container, reconnectAttempts: 0, reconnectTimer: null as ReturnType<typeof setTimeout> | null };
    termInstances.set(tabId, inst);

    ws.onopen = () => {
      inst.connected = true;
      inst.reconnectAttempts = 0;
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
      setTabs(prev => [...prev]);

      // Auto-reconnect if this tab has a tmux session
      const tab = tabsRef.current.find(t => t.id === tabId);
      if (tab?.tmuxSession && inst.reconnectAttempts < 5) {
        const delay = Math.min(2000 * Math.pow(1.5, inst.reconnectAttempts), 15000);
        inst.reconnectAttempts++;
        term.write(`\r\n\x1b[33m[Reconnecting in ${Math.round(delay / 1000)}s...]\x1b[0m\r\n`);
        inst.reconnectTimer = setTimeout(() => attemptReconnect(tabId, tab.tmuxSession, container), delay);
      } else {
        term.write('\r\n\x1b[33m[Disconnected]\x1b[0m\r\n');
      }
    };

    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    });

    term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    });
  }, []);

  // Re-attach to a tmux session via the server, then reconnect WS
  const attemptReconnect = useCallback(async (tabId: string, tmuxSession: string, container: HTMLDivElement) => {
    const { token, serverUrl } = getServerUrls();
    const inst = termInstances.get(tabId);

    try {
      // Ask server to attach to the tmux session (creates a new PTY)
      const res = await fetch(`${serverUrl}/api/terminals/attach`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ tmuxSession }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      // Server gave us a new terminal ID — update tab and reconnect
      const newId = data.id;
      if (inst) {
        inst.ws?.close();
        inst.term?.dispose();
        if (inst.reconnectTimer) clearTimeout(inst.reconnectTimer);
        termInstances.delete(tabId);
      }

      // Update tab ID in state
      setTabs(prev => prev.map(t => t.id === tabId ? { ...t, id: newId, tmuxSession: data.tmuxSession || tmuxSession } : t));
      setActiveTabId(prev => prev === tabId ? newId : prev);

      // Create fresh connection with new ID
      createTermConnection(newId, container);
    } catch {
      // Re-attach failed — schedule another retry if under limit
      if (inst && inst.reconnectAttempts < 5) {
        const delay = Math.min(2000 * Math.pow(1.5, inst.reconnectAttempts), 15000);
        inst.reconnectAttempts++;
        inst.term?.write(`\r\n\x1b[33m[Reconnect failed, retrying in ${Math.round(delay / 1000)}s...]\x1b[0m\r\n`);
        inst.reconnectTimer = setTimeout(() => attemptReconnect(tabId, tmuxSession, container), delay);
      } else if (inst) {
        inst.term?.write('\r\n\x1b[31m[Reconnect failed — session may be gone]\x1b[0m\r\n');
      }
    }
  }, [createTermConnection]);

  const [aiClis, setAiClis] = useState<{ name: string; path: string }[]>([]);

  // Fetch available AI CLIs on mount
  useEffect(() => {
    const { token, serverUrl } = getServerUrls();
    fetch(`${serverUrl}/api/ai-clis`, { headers: { 'Authorization': `Bearer ${token}` } })
      .then(r => r.json())
      .then(data => setAiClis(data))
      .catch(() => {});
  }, []);

  const addTab = useCallback(async (aiCli?: string) => {
    const { token, serverUrl } = getServerUrls();
    try {
      const res = await fetch(`${serverUrl}/api/terminals`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ aiCli }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      const newTab: TermTab = {
        id: data.id,
        tmuxSession: data.tmuxSession || '',
        name: aiCli || `Shell ${tabsRef.current.length + 1}`,
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
      // Filter out sessions that have an active (connected) tab
      const activeAttached = new Set(
        tabsRef.current
          .filter(t => t.tmuxSession && termInstances.get(t.id)?.connected)
          .map(t => t.tmuxSession)
      );
      setTmuxSessions((data as string[]).filter(s => !activeAttached.has(s)));
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
      if (inst.reconnectTimer) clearTimeout(inst.reconnectTimer);
      inst.reconnectAttempts = 999; // prevent reconnect on close
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

  // On mount: restore existing terminals from server, or show CLI chooser
  const mountedRef = useRef(false);
  useEffect(() => {
    if (mountedRef.current) return;
    mountedRef.current = true;
    const { token, serverUrl } = getServerUrls();

    // Try to restore existing terminals first
    fetch(`${serverUrl}/api/terminals`, { headers: { 'Authorization': `Bearer ${token}` } })
      .then(r => r.json())
      .then((existing: { id: string; tmuxSession: string; lastCommand: string }[]) => {
        if (existing.length > 0) {
          // Restore tabs for existing terminals
          const restored: TermTab[] = existing.map((t, i) => ({
            id: t.id,
            tmuxSession: t.tmuxSession || '',
            name: t.lastCommand || t.tmuxSession || `Shell ${i + 1}`,
            checked: false,
          }));
          setTabs(restored);
          setActiveTabId(restored[0].id);
        } else {
          // No existing terminals — fetch AI CLIs and show chooser or auto-create
          fetch(`${serverUrl}/api/ai-clis`, { headers: { 'Authorization': `Bearer ${token}` } })
            .then(r => r.json())
            .then((clis: { name: string }[]) => {
              if (clis.length > 1) {
                // Multiple CLIs — don't auto-launch, let user choose from + menu
                // Create a plain shell tab so there's something visible
                addTab();
              } else if (clis.length === 1) {
                addTab(clis[0].name);
              } else {
                addTab();
              }
            })
            .catch(() => addTab());
        }
      })
      .catch(() => addTab());
    return () => {
      for (const [, inst] of termInstances) {
        if (inst.reconnectTimer) clearTimeout(inst.reconnectTimer);
        inst.ws?.close();
        inst.term?.dispose();
      }
      termInstances.clear();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Mount active terminal to single container (non-tile mode)
  useEffect(() => {
    if (!fontReady || tileMode || !activeTabId || !singleRef.current) return;
    const container = singleRef.current;
    const inst = termInstances.get(activeTabId);
    if (inst && inst.container === container) {
      // Already mounted here — just refit
      setTimeout(() => { try { inst.fitAddon.fit(); } catch {} }, 50);
      return;
    }
    // Use setTimeout to ensure container has layout dimensions before mounting
    setTimeout(() => {
      if (!container.isConnected) return;
      if (inst) {
        // Restore full font size and re-mount into single container
        inst.term.options.fontSize = 14;
        container.innerHTML = '';
        inst.term.open(container);
        inst.container = container;
        setTimeout(() => { try { inst.fitAddon.fit(); } catch {} }, 50);
        inst.term.focus();
      } else if (tabs.find(t => t.id === activeTabId)) {
        // New terminal — connect
        createTermConnection(activeTabId, container);
      }
    }, 50);
  }, [activeTabId, tileMode, tabs.length, fontReady]); // eslint-disable-line react-hooks/exhaustive-deps

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
  const activeTab = tabs.find(t => t.id === activeTabId);

  // Dynamic grid: 1→1, 2→2, 3-4→2, 5-6→3, 7-9→3, 10+→4
  const tileCols = checkedTabs.length <= 2 ? checkedTabs.length
    : checkedTabs.length <= 4 ? 2
    : checkedTabs.length <= 9 ? 3
    : 4;

  // Scale font size down in tile mode based on grid density
  const tileRows = Math.ceil(checkedTabs.length / Math.max(tileCols, 1));
  const tileFontSize = tileRows <= 1 ? 13 : tileRows <= 2 ? 10 : tileRows <= 3 ? 8 : 7;

  // Collect tile container refs (no mounting here — just store the DOM element)
  const tileRefCallback = useCallback((el: HTMLDivElement | null, tabId: string) => {
    if (el) {
      tileContainerRefs.current.set(tabId, el);
    } else {
      tileContainerRefs.current.delete(tabId);
    }
  }, []);

  // Mount terminals into tile containers when tile mode is active
  useEffect(() => {
    if (!tileMode || !fontReady) {
      if (!tileMode) {
        // Restore normal font size when leaving tile mode
        for (const [, inst] of termInstances) {
          if (inst.term.options.fontSize !== 14) {
            inst.term.options.fontSize = 14;
            try { inst.fitAddon.fit(); } catch {}
          }
        }
      }
      return;
    }
    let cancelled = false;
    let retries = 0;
    const mountTiles = () => {
      if (cancelled) return;
      const checked = tabsRef.current.filter(t => t.checked);
      let pending = 0;
      for (const tab of checked) {
        const el = tileContainerRefs.current.get(tab.id);
        if (!el || !el.isConnected) { pending++; continue; }
        // Wait for container to have layout dimensions
        if (el.clientHeight === 0) { pending++; continue; }
        const inst = termInstances.get(tab.id);
        if (inst) {
          inst.term.options.fontSize = tileFontSize;
          el.innerHTML = '';
          inst.term.open(el);
          inst.container = el;
          try { inst.fitAddon.fit(); } catch {}
        } else {
          createTermConnection(tab.id, el, tileFontSize);
        }
      }
      // Retry if some containers aren't ready yet (up to 2 seconds)
      if (pending > 0 && retries < 20) {
        retries++;
        setTimeout(mountTiles, 100);
      }
    };
    // Start mounting after a brief delay for initial DOM layout
    const timer = setTimeout(mountTiles, 50);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [tileMode, fontReady, checkedTabs.length, tileFontSize, createTermConnection]); // eslint-disable-line react-hooks/exhaustive-deps

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
                onClick={() => toggleCheck(tab.id)}
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
                  onClick={(e: React.MouseEvent) => { e.stopPropagation(); toggleCheck(tab.id); if (!tileMode) setActiveTabId(tab.id); }}
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
        <button
          type="button"
          aria-label={tileMode ? 'Single view' : 'Tile checked terminals'}
          title={tileMode ? 'Single view' : 'Tile checked terminals'}
          disabled={!hasChecked}
          onClick={() => setTileMode(m => !m)}
          style={{
            margin: '0 4px', flexShrink: 0, opacity: hasChecked ? 1 : 0.3,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 28, height: 28, borderRadius: 6, cursor: hasChecked ? 'pointer' : 'default',
            backgroundColor: tileMode ? 'var(--bgColor-accent-emphasis, #316dca)' : 'transparent',
            color: tileMode ? 'var(--fgColor-onEmphasis, #fff)' : 'var(--fgColor-muted, #768390)',
            border: 'none', padding: 0,
          }}
        >
          <AppsIcon size={16} />
        </button>
        <ActionMenu>
          <ActionMenu.Anchor>
            <IconButton icon={LinkIcon} aria-label="Attach tmux session" variant="invisible" size="small" sx={{ flexShrink: 0, color: 'accent.fg' }} onClick={fetchTmuxSessions} />
          </ActionMenu.Anchor>
          <ActionMenu.Overlay sx={{ bg: 'canvas.overlay', borderColor: 'border.default', boxShadow: 'shadow.large' }}>
            <ActionList sx={{ bg: 'canvas.overlay' }}>
              <ActionList.GroupHeading>Attach tmux session</ActionList.GroupHeading>
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
        <ActionMenu>
          <ActionMenu.Anchor>
            <IconButton icon={PlusIcon} aria-label="New terminal" variant="invisible" size="small" sx={{ mx: 1, flexShrink: 0, color: 'success.fg' }} />
          </ActionMenu.Anchor>
          <ActionMenu.Overlay sx={{ bg: 'canvas.overlay', borderColor: 'border.default', boxShadow: 'shadow.large' }}>
            <ActionList sx={{ bg: 'canvas.overlay' }}>
              <ActionList.GroupHeading>New terminal</ActionList.GroupHeading>
              {aiClis.map(cli => (
                <ActionList.Item key={cli.name} onSelect={() => addTab(cli.name)}>
                  {cli.name === 'copilot' ? '🤖' : '🧠'} {cli.name}
                </ActionList.Item>
              ))}
              <ActionList.Divider />
              <ActionList.Item onSelect={() => addTab()}>
                💻 Shell
              </ActionList.Item>
            </ActionList>
          </ActionMenu.Overlay>
        </ActionMenu>
      </Box>

      {/* Tmux info bar */}
      {!tileMode && activeTab?.tmuxSession && (
        <Box sx={{ px: 2, py: '3px', bg: 'canvas.inset', borderBottom: '1px solid', borderColor: 'border.muted', display: 'flex', alignItems: 'center', gap: 2 }}>
          <Text sx={{ fontSize: '11px', color: 'fg.muted', fontFamily: 'mono' }}>
            tmux attach -t {activeTab.tmuxSession}
          </Text>
          <Box
            as="button"
            onClick={() => { navigator.clipboard.writeText(`tmux attach -t ${activeTab.tmuxSession}`); }}
            sx={{ bg: 'transparent', border: '1px solid', borderColor: 'border.muted', borderRadius: 1, color: 'fg.muted', cursor: 'pointer', px: 1, py: 0, fontSize: '10px', ':hover': { color: 'fg.default', borderColor: 'border.default' } }}
          >
            copy
          </Box>
        </Box>
      )}

      {/* Terminal area */}
      {tileMode && hasChecked ? (
        /* Tile grid */
        <Box sx={{
          flex: 1, minHeight: 0, minWidth: 0, overflow: 'hidden', display: 'grid',
          gridTemplateColumns: `repeat(${tileCols}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${Math.ceil(checkedTabs.length / tileCols)}, minmax(0, 1fr))`,
          gap: '1px', bg: 'border.default', width: '100%',
        }}>
          {checkedTabs.map(tab => (
            <Box key={tab.id} sx={{ display: 'flex', flexDirection: 'column', bg: '#0d1117', minHeight: 0, minWidth: 0, overflow: 'hidden' }}>
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
                sx={{ flex: 1, minHeight: 0, minWidth: 0, overflow: 'hidden', '& .xterm': { height: '100%', width: '100%' }, '& .xterm-viewport': { overflow: 'hidden !important' }, '& .xterm-screen': { width: '100% !important' } }}
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
