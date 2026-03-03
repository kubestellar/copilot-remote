import { useEffect, useLayoutEffect, useRef, useCallback, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Box, IconButton, Text, ActionMenu, ActionList } from '@primer/react';
import { PlusIcon, XIcon, ArrowLeftIcon, AppsIcon, LinkIcon, PencilIcon, TrashIcon, ListUnorderedIcon, GlobeIcon } from '@primer/octicons-react';
import { useTodoDispatcher } from '../hooks/useTodoDispatcher';
import { useSwarmStatus } from '../hooks/useSwarmStatus';
import { api } from '../lib/api';
import TodoPanel from './TodoPanel';
import SwarmPopover from './SwarmPopover';
import '@xterm/xterm/css/xterm.css';

/* Constrain xterm inside tile cells */
const tileXtermStyles = document.createElement('style');
tileXtermStyles.textContent = `
  .tile-xterm-container .xterm { height: 100% !important; width: 100% !important; }
  .tile-xterm-container .xterm-screen { width: 100% !important; }
  .xterm-viewport { overflow-y: scroll !important; scrollbar-width: none !important; }
  .xterm-viewport::-webkit-scrollbar { display: none !important; }
  .drag-over-highlight { outline: 2px dashed #58a6ff !important; outline-offset: -2px; position: relative; }
  .drag-over-highlight::after {
    content: 'Drop image here';
    position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
    color: #58a6ff; font-size: 14px; font-weight: 600;
    pointer-events: none; z-index: 10; text-shadow: 0 0 8px rgba(0,0,0,0.8);
    background: rgba(13, 17, 23, 0.7); padding: 8px 16px; border-radius: 6px;
  }
  .copy-toast {
    position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%) translateY(20px);
    background: rgba(30, 37, 46, 0.85); color: #8b949e; font-size: 11px;
    padding: 4px 12px; border-radius: 4px; pointer-events: none; z-index: 9999;
    opacity: 0; transition: opacity 0.2s, transform 0.2s;
    font-family: -apple-system, BlinkMacSystemFont, sans-serif;
  }
  .copy-toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
`;
if (!document.head.querySelector('[data-tile-xterm]')) {
  tileXtermStyles.setAttribute('data-tile-xterm', '');
  document.head.appendChild(tileXtermStyles);
}

/** Last text copied via OSC 52 — fallback for clipboard API failures */
let _lastOsc52Text = '';

/** Show a subtle toast when text is copied */
function showCopyToast(text: string) {
  let el = document.getElementById('copy-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'copy-toast';
    el.className = 'copy-toast';
    document.body.appendChild(el);
  }
  const preview = text.length > 30 ? text.slice(0, 30) + '…' : text;
  el.textContent = `Copied: ${preview.replace(/\n/g, '↵')}`;
  el.classList.add('show');
  clearTimeout((el as any)._timer);
  (el as any)._timer = setTimeout(() => el!.classList.remove('show'), 1500);
}

interface TermTab {
  id: string;
  tmuxSession: string;
  name: string;
  checked: boolean;
  userRenamed?: boolean;
  lastIntent?: string;
  lastCommand?: string;
}

const termInstances = new Map<string, {
  term: Terminal;
  fitAddon: FitAddon;
  ws: WebSocket;
  connected: boolean;
  container: HTMLDivElement | null;
  reconnectAttempts: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  throttler: WriteThrottler;
}>();

// When true, fitAddon.fit() still adjusts rendering but resize is NOT sent to the PTY.
// This prevents Claude Code / agent CLIs from clearing their screen when tiles rearrange.
let suppressPtyResize = false;

function getServerUrls() {
  const token = localStorage.getItem('copilot-remote-token') || '';
  const serverUrl = localStorage.getItem('copilot-remote-server') || `${window.location.protocol}//${window.location.hostname}:3001`;
  const wsUrl = serverUrl.replace(/^http/, 'ws');
  return { token, serverUrl, wsUrl };
}

const TAB_NAMES_KEY = 'copilot-remote-tab-names';

/** Load cached tab names from localStorage (keyed by tmux session name) */
function loadTabNameCache(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(TAB_NAMES_KEY) || '{}');
  } catch { return {}; }
}

/** Save tab name cache to localStorage */
function saveTabNameCache(cache: Record<string, string>) {
  localStorage.setItem(TAB_NAMES_KEY, JSON.stringify(cache));
}

/** Get a cached name for a tmux session, or null */
function getCachedTabName(tmuxSession: string): string | null {
  if (!tmuxSession) return null;
  return loadTabNameCache()[tmuxSession] || null;
}

/** Cache a tab name by tmux session */
function setCachedTabName(tmuxSession: string, name: string) {
  if (!tmuxSession) return;
  const cache = loadTabNameCache();
  cache[tmuxSession] = name;
  saveTabNameCache(cache);
}

/** Remove a cached tab name */
function removeCachedTabName(tmuxSession: string) {
  if (!tmuxSession) return;
  const cache = loadTabNameCache();
  delete cache[tmuxSession];
  saveTabNameCache(cache);
}

/** Check if a string is a tmux session identifier (not a meaningful tab name) */
const TMUX_SESSION_ID_RE = /^cr-\d+$/;
function isMeaningfulName(name: string): boolean {
  return !!name && !TMUX_SESSION_ID_RE.test(name);
}

/** Generate a unique tab name given existing tab names */
function uniqueName(baseName: string, existingNames: string[]): string {
  if (!existingNames.includes(baseName)) return baseName;
  let i = 2;
  while (existingNames.includes(`${baseName}-${i}`)) i++;
  return `${baseName}-${i}`;
}

const CHECKED_TILES_KEY = 'copilot-remote-checked-tiles';
const TILE_MODE_KEY = 'copilot-remote-tile-mode';
const TODO_PANEL_KEY = 'copilot-remote-show-todo-panel';
const ACTIVE_TERMINAL_KEY = 'copilot-remote-active-terminal';
/** CSS class applied to terminal containers during image drag-over */
const DRAG_OVER_CLASS = 'drag-over-highlight';

/** Load saved checked tmux session names */
function loadCheckedSessions(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(CHECKED_TILES_KEY) || '[]'));
  } catch { return new Set(); }
}

/** Save checked tmux session names */
function saveCheckedSessions(tabs: TermTab[]) {
  const checked = tabs.filter(t => t.checked && t.tmuxSession).map(t => t.tmuxSession);
  localStorage.setItem(CHECKED_TILES_KEY, JSON.stringify(checked));
}

/**
 * Batches rapid terminal output to prevent "rocket scroll" from agent CLIs.
 * When output arrives faster than FLUSH_INTERVAL, chunks are queued and
 * flushed at a steady rate so the UI stays smooth.
 */
class WriteThrottler {
  private queue = '';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private static readonly FLUSH_INTERVAL = 16; // ~60fps
  private static readonly BURST_THRESHOLD = 4096; // bytes in queue to start batching

  constructor(private term: Terminal) {}

  write(data: string) {
    this.queue += data;
    if (!this.timer) {
      // If queue is small, write immediately for low-latency feel
      if (this.queue.length < WriteThrottler.BURST_THRESHOLD) {
        this.flush();
      } else {
        this.timer = setTimeout(() => this.flush(), WriteThrottler.FLUSH_INTERVAL);
      }
    }
  }

  private flush() {
    this.timer = null;
    if (this.queue) {
      const data = this.queue;
      this.queue = '';
      this.term.write(data);
      // If more data accumulated during write, schedule next flush
      if (this.queue) {
        this.timer = setTimeout(() => this.flush(), WriteThrottler.FLUSH_INTERVAL);
      }
    }
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer);
    if (this.queue) { this.term.write(this.queue); this.queue = ''; }
  }
}

const TERM_OPTS: NonNullable<ConstructorParameters<typeof Terminal>[0]> = {
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
  const [tileMode, setTileMode] = useState(() => localStorage.getItem(TILE_MODE_KEY) === 'true');
  const [fontReady, setFontReady] = useState(false);
  const [focusedTileId, setFocusedTileId] = useState<string | null>(null);
  const focusedTileIdRef = useRef(focusedTileId);
  focusedTileIdRef.current = focusedTileId;
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [showTodoPanel, setShowTodoPanel] = useState(() => localStorage.getItem(TODO_PANEL_KEY) !== 'false');
  const containerRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const intentRef = useRef<Map<string, string>>(new Map());
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;

  // Persist tile mode and checked tiles to localStorage
  useEffect(() => {
    localStorage.setItem(TILE_MODE_KEY, String(tileMode));
  }, [tileMode]);

  // Persist active terminal tab (by tmuxSession name so it survives restarts)
  useEffect(() => {
    if (!activeTabId) return;
    const tab = tabs.find(t => t.id === activeTabId);
    if (tab?.tmuxSession) {
      localStorage.setItem(ACTIVE_TERMINAL_KEY, tab.tmuxSession);
    }
  }, [activeTabId, tabs]);

  useEffect(() => {
    localStorage.setItem(TODO_PANEL_KEY, String(showTodoPanel));
  }, [showTodoPanel]);

  // Getter for termInstances (passed to hook to avoid stale closure)
  const getTermInstances = useCallback(() => termInstances, []);

  // Todo dispatcher hook
  // Use tileActive (not raw tileMode) so dispatch uses single-tab logic when
  // tile mode is on but no tabs are checked (which renders single view).
  const tileActive = tileMode && tabs.some(t => t.checked);
  const todoDispatcher = useTodoDispatcher(getTermInstances, tabs, activeTabId, tileActive);
  const todoDispatcherRef = useRef(todoDispatcher);
  todoDispatcherRef.current = todoDispatcher;

  // Swarm mode status
  const swarm = useSwarmStatus();
  const [showSwarmPopover, setShowSwarmPopover] = useState(false);

  useEffect(() => {
    if (tabs.length > 0) saveCheckedSessions(tabs);
  }, [tabs]);

  // Preload terminal font before creating any xterm instances
  useEffect(() => {
    document.fonts.load('14px "MesloLGS NF"').then(() => {
      setFontReady(true);
    }).catch(() => {
      // Font not available — proceed with fallback
      setFontReady(true);
    });
  }, []);

  const createTermConnection = useCallback((tabId: string, container: HTMLDivElement) => {
    // Clean up if exists
    const existing = termInstances.get(tabId);
    if (existing) {
      if (existing.reconnectTimer) clearTimeout(existing.reconnectTimer);
      existing.ws?.close();
      existing.term?.dispose();
      termInstances.delete(tabId);
    }

    const { token, wsUrl } = getServerUrls();
    const term = new Terminal({ ...TERM_OPTS, fontSize: TERM_OPTS.fontSize });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());

    container.innerHTML = '';
    term.open(container);
    // Suppress browser context menu so tmux right-click menus work
    term.element?.addEventListener('contextmenu', (e) => e.preventDefault());

    // Clipboard: Cmd/Ctrl+C (copy), Cmd/Ctrl+V (paste), Cmd/Ctrl+X (cut), Cmd/Ctrl+A (select all)
    // Returning false tells xterm to skip processing (won't send control chars to PTY)
    // but does NOT preventDefault, so the browser's native clipboard events still fire.
    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.type !== 'keydown') return true;
      const isMac = navigator.platform.startsWith('Mac');
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (!mod) return true;

      // Paste: let browser handle natively (fires paste event → xterm processes it)
      if (e.key === 'v') return false;
      // Copy / Cut: copy xterm selection to system clipboard
      if ((e.key === 'c' || e.key === 'x') && term.hasSelection()) {
        navigator.clipboard.writeText(term.getSelection()).catch(() => {});
        return false;
      }
      // On Mac, Cmd+C with no selection should be a no-op (Ctrl+C is the interrupt)
      if (isMac && e.key === 'c') return false;
      // Select all
      if (e.key === 'a') {
        term.selectAll();
        return false;
      }
      return true;
    });

    // Fit after layout is computed: rAF ensures DOM layout, then fit
    requestAnimationFrame(() => {
      try { fitAddon.fit(); } catch (_err) { /* fit may fail before terminal is fully mounted */ }
    });

    const ws = new WebSocket(`${wsUrl}/ws/terminal?token=${token}&id=${tabId}`);
    const throttler = new WriteThrottler(term);
    const inst = { term, fitAddon, ws, connected: false, container, reconnectAttempts: 0, reconnectTimer: null as ReturnType<typeof setTimeout> | null, throttler };
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
          setTabs(prev => prev.map(t => {
            if (t.id !== parsed.id) return t;
            const newName = t.userRenamed ? t.name : parsed.command;
            // Cache the tab name so it survives browser refresh
            if (t.tmuxSession && isMeaningfulName(newName)) {
              setCachedTabName(t.tmuxSession, newName);
            }
            return { ...t, name: newName, lastCommand: parsed.command };
          }));
          return;
        }
        if (parsed.type === 'exit') {
          // Process exited — mark so onclose doesn't try to reconnect
          (inst as any).processExited = true;
          return;
        }
        if (parsed.type === 'prompt') {
          // Shell prompt returned — notify todo dispatcher
          todoDispatcherRef.current.onTilePromptReturned(tabId);
          return;
        }
      } catch (_parseErr) { /* raw terminal data */ }
      // Intercept OSC 52 clipboard sequences from tmux
      if (typeof e.data === 'string') {
        const osc52Re = /\x1b\]52;([^;]*);([^\x07\x1b]*?)(?:\x07|\x1b\\)/g;
        let match;
        while ((match = osc52Re.exec(e.data)) !== null) {
          try {
            const decoded = atob(match[2]);
            if (decoded.trim()) {
              _lastOsc52Text = decoded;
              showCopyToast(decoded);
              navigator.clipboard.writeText(decoded).catch(() => {});
            }
          } catch {}
        }
      }
      throttler.write(e.data);
    };

    ws.onclose = () => {
      inst.connected = false;
      setTabs(prev => [...prev]);

      // Notify todo dispatcher of disconnection
      todoDispatcherRef.current.onTileDisconnected(tabId);

      // If the process exited (not just a connection drop), auto-remove the tab after a short delay
      if ((inst as any).processExited) {
        term.write('\r\n\x1b[33m[Session ended — closing tab]\x1b[0m\r\n');
        setTimeout(() => closeTabRef.current(tabId), 2000);
        return;
      }

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

    // Forward mouse events (scroll, click) so tmux mouse mode works
    term.onBinary((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    });

    term.onResize(({ cols, rows }) => {
      if (!suppressPtyResize && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    });

    // Capture pane title changes (set by CLI tools like Copilot via \033]0;...\007)
    term.onTitleChange((title) => {
      const prev = intentRef.current.get(tabId);
      if (title && title !== prev) {
        intentRef.current.set(tabId, title);
        setTabs(p => p.map(t => t.id === tabId ? { ...t, lastIntent: title } : t));
      }
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
        inst.throttler?.dispose();
        if (inst.reconnectTimer) clearTimeout(inst.reconnectTimer);
        termInstances.delete(tabId);
      }
      // Delete old terminal from server if ID changed
      if (newId !== tabId) {
        fetch(`${serverUrl}/api/terminals/${tabId}`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${token}` },
        }).catch(() => {});
      }

      // Update tab ID in state
      setTabs(prev => prev.map(t => t.id === tabId ? { ...t, id: newId, tmuxSession: data.tmuxSession || tmuxSession } : t));
      setActiveTabId(prev => prev === tabId ? newId : prev);

      // Create fresh connection with new ID
      createTermConnection(newId, container);
    } catch (err) {
      console.error('[TerminalView] Re-attach failed:', err);
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
      const baseName = aiCli || `Shell ${tabsRef.current.length + 1}`;
      const name = getCachedTabName(data.tmuxSession) || uniqueName(baseName, tabsRef.current.map(t => t.name));
      setCachedTabName(data.tmuxSession || '', name);
      const newTab: TermTab = {
        id: data.id,
        tmuxSession: data.tmuxSession || '',
        name,
        checked: loadCheckedSessions().has(data.tmuxSession || ''),
      };
      setTabs(prev => [...prev, newTab]);
      setActiveTabId(data.id);
    } catch (err) {
      console.error('Failed to create terminal:', err);
    }
  }, []);

  const [tmuxSessions, setTmuxSessions] = useState<string[]>([]);

  const killTmuxSession = useCallback(async (sessionName: string) => {
    const { token, serverUrl } = getServerUrls();
    try {
      removeCachedTabName(sessionName);
      await fetch(`${serverUrl}/api/tmux-sessions/${encodeURIComponent(sessionName)}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      // Also close any local tab referencing this session
      const tab = tabsRef.current.find(t => t.tmuxSession === sessionName);
      if (tab) closeTabRef.current(tab.id);
      setTmuxSessions(prev => prev.filter(s => s !== sessionName));
    } catch (err) {
      console.error('Failed to kill tmux session:', err);
    }
  }, []);

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
      const cachedName = getCachedTabName(data.tmuxSession || tmuxSession);
      const name = cachedName || uniqueName(tmuxSession, tabsRef.current.map(t => t.name));
      setCachedTabName(data.tmuxSession || tmuxSession, name);
      const newTab: TermTab = {
        id: data.id,
        tmuxSession: data.tmuxSession || tmuxSession,
        name,
        checked: loadCheckedSessions().has(data.tmuxSession || tmuxSession),
        userRenamed: !!cachedName,
      };
      setTabs(prev => [...prev, newTab]);
      setActiveTabId(data.id);
    } catch (err) {
      console.error('Failed to attach tmux session:', err);
    }
  }, []);

  // Auto-discover new non-cr-* tmux sessions and attach them as tabs
  const knownTmuxRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const interval = setInterval(async () => {
      const { token, serverUrl } = getServerUrls();
      try {
        const res = await fetch(`${serverUrl}/api/tmux-sessions`, {
          headers: { 'Authorization': `Bearer ${token}` },
        });
        const sessions: string[] = await res.json();
        for (const s of sessions) {
          if (!knownTmuxRef.current.has(s)) {
            knownTmuxRef.current.add(s);
            // Auto-attach this newly discovered session
            const attachRes = await fetch(`${serverUrl}/api/terminals/attach`, {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ tmuxSession: s }),
            });
            const data = await attachRes.json();
            if (!data.error) {
              setTabs(prev => {
                if (prev.some(t => t.tmuxSession === s)) return prev;
                const cachedName = getCachedTabName(data.tmuxSession || s);
                const meaningfulCached = cachedName && isMeaningfulName(cachedName) ? cachedName : null;
                const fallbackName = isMeaningfulName(s) ? s : `Shell ${prev.length + 1}`;
                const name = meaningfulCached || uniqueName(fallbackName, prev.map(t => t.name));
                if (isMeaningfulName(name)) setCachedTabName(data.tmuxSession || s, name);
                return [...prev, { id: data.id, tmuxSession: data.tmuxSession || s, name, checked: loadCheckedSessions().has(data.tmuxSession || s), userRenamed: !!meaningfulCached }];
              });
            }
          }
        }
        // Remove sessions that no longer exist
        for (const s of knownTmuxRef.current) {
          if (!sessions.includes(s)) knownTmuxRef.current.delete(s);
        }
      } catch {}
    }, 3000);
    return () => clearInterval(interval);
  }, []);

  const closeTab = useCallback((id: string) => {
    const { token, serverUrl } = getServerUrls();
    const inst = termInstances.get(id);
    if (inst) {
      if (inst.reconnectTimer) clearTimeout(inst.reconnectTimer);
      inst.reconnectAttempts = 999; // prevent reconnect on close
      inst.ws?.close();
      inst.term?.dispose();
      inst.throttler?.dispose();
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

  /** Close tab AND terminate the underlying tmux session */
  const closeAndTerminateTab = useCallback((id: string) => {
    const { token, serverUrl } = getServerUrls();
    const tab = tabsRef.current.find(t => t.id === id);
    if (tab?.tmuxSession) {
      removeCachedTabName(tab.tmuxSession);
      fetch(`${serverUrl}/api/tmux-sessions/${encodeURIComponent(tab.tmuxSession)}`, {
        method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` },
      }).catch(() => {});
    }
    closeTab(id);
  }, [closeTab]);

  const closeTabRef = useRef(closeTab);
  closeTabRef.current = closeTab;

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
        // Restore terminals that have a CLI running OR a tmux session (re-adopted)
        const restorable = existing.filter(t => (t.lastCommand && t.lastCommand !== '') || t.tmuxSession);
        if (restorable.length > 0) {
          // Deduplicate by tmux session — keep latest per session, delete extras
          const bySession = new Map<string, typeof restorable[0]>();
          const dupes: typeof restorable = [];
          for (const t of restorable) {
            const key = t.tmuxSession || t.id;
            if (bySession.has(key)) {
              dupes.push(bySession.get(key)!);
            }
            bySession.set(key, t);
          }
          const unique = Array.from(bySession.values());
          // Restore tabs for unique terminals
          const usedNames: string[] = [];
           const savedChecked = loadCheckedSessions();
          const restored: TermTab[] = unique.map((t, i) => {
            const cached = getCachedTabName(t.tmuxSession);
            // Only use cached/lastCommand/tmuxSession if they're meaningful (not raw session IDs)
            const meaningfulCached = cached && isMeaningfulName(cached) ? cached : null;
            const meaningfulCmd = t.lastCommand && isMeaningfulName(t.lastCommand) ? t.lastCommand : null;
            const baseName = meaningfulCached || meaningfulCmd || `Shell ${i + 1}`;
            const name = uniqueName(baseName, usedNames);
            usedNames.push(name);
            // Only cache meaningful names (avoid polluting cache with session IDs)
            if (t.tmuxSession && isMeaningfulName(name)) setCachedTabName(t.tmuxSession, name);
            return {
              id: t.id,
              tmuxSession: t.tmuxSession || '',
              name,
              checked: savedChecked.has(t.tmuxSession),
              userRenamed: !!meaningfulCached,
              lastCommand: t.lastCommand || undefined,
            };
          });
          setTabs(restored);
          // Restore previously active terminal, or fall back to first tab
          const savedSession = localStorage.getItem(ACTIVE_TERMINAL_KEY);
          const savedTab = savedSession ? restored.find(t => t.tmuxSession === savedSession) : null;
          setActiveTabId(savedTab ? savedTab.id : restored[0].id);
          // Clean up duplicates only (not empty-lastCommand ones — they may be re-adopted)
          for (const t of dupes) {
            fetch(`${serverUrl}/api/terminals/${t.id}`, {
              method: 'DELETE',
              headers: { 'Authorization': `Bearer ${token}` },
            }).catch(() => {});
          }
        } else {
          // No terminals with AI CLIs — clean up stale ones and start fresh
          for (const t of existing) {
            fetch(`${serverUrl}/api/terminals/${t.id}`, {
              method: 'DELETE',
              headers: { 'Authorization': `Bearer ${token}` },
            }).catch(() => {});
          }
          // Fetch AI CLIs and auto-launch
          fetch(`${serverUrl}/api/ai-clis`, { headers: { 'Authorization': `Bearer ${token}` } })
            .then(r => r.json())
            .then((clis: { name: string }[]) => {
              if (clis.length >= 1) {
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
        inst.throttler?.dispose();
        inst.term?.dispose();
      }
      termInstances.clear();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Eagerly create terminal connections for ALL tabs so content is ready before switching
  useEffect(() => {
    if (!fontReady) return;
    for (const tab of tabs) {
      const container = containerRefs.current.get(tab.id);
      if (!container) continue;
      const existing = termInstances.get(tab.id);
      if (existing) continue;
      createTermConnection(tab.id, container);
    }
  }, [tabs, fontReady, createTermConnection]);

  // Handle active tab: focus terminal
  useEffect(() => {
    if (!fontReady || !activeTabId) return;
    const inst = termInstances.get(activeTabId);
    if (!inst) return;
    // Only fit in single mode (tile mode uses CSS scaling)
    if (!tileActive) {
      try { inst.fitAddon.fit(); } catch (_err) { /* fit may fail before terminal is fully mounted */ }
    }
    inst.term.scrollToBottom();
    inst.term.focus();
  }, [activeTabId, tileActive, tabs.length, fontReady]); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle window resize — fit all terminals since visibility:hidden preserves layout
  useEffect(() => {
    const handleResize = () => {
      for (const [, inst] of termInstances) {
        try { inst.fitAddon.fit(); } catch (_err) { /* fit may fail before terminal is fully mounted */ }
      }
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [tileMode]);

  // Intercept wheel events on terminals to prevent macOS trackpad momentum
  // "rocket scroll". Strategy: block ALL original wheel events on .xterm,
  // then re-dispatch a delta-clamped copy at a throttled rate. This prevents
  // momentum events (which carry huge deltaY values) from causing rapid scroll.
  useEffect(() => {
    let lastWheel = 0;
    const synthetic = new WeakSet<WheelEvent>();
    const MAX_DELTA = 50; // ~3 lines per event in xterm.js
    const THROTTLE_MS = 120; // ~8 events/sec max

    const handler = (e: WheelEvent) => {
      if (synthetic.has(e)) return; // our own re-dispatched event — let through
      const target = e.target as HTMLElement;
      if (!target?.closest?.('.xterm')) return;

      // Always block the original (may have huge momentum deltaY)
      e.preventDefault();
      e.stopImmediatePropagation();

      const now = performance.now();
      if (now - lastWheel < THROTTLE_MS) return; // throttled
      lastWheel = now;

      // Re-dispatch with clamped delta so xterm.js scrolls a controlled amount
      const clamped = new WheelEvent('wheel', {
        deltaX: e.deltaX,
        deltaY: Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY), MAX_DELTA),
        deltaZ: e.deltaZ,
        deltaMode: e.deltaMode,
        clientX: e.clientX,
        clientY: e.clientY,
        screenX: e.screenX,
        screenY: e.screenY,
        bubbles: true,
        cancelable: true,
        view: e.view,
      });
      synthetic.add(clamped);
      target.dispatchEvent(clamped);
    };
    document.addEventListener('wheel', handler, { capture: true, passive: false } as any);
    return () => {
      document.removeEventListener('wheel', handler, { capture: true } as any);
    };
  }, []);

  // Poll tmux pane titles for intent display (covers titles set before we attached)
  useEffect(() => {
    const { serverUrl, token } = getServerUrls();
    const poll = () => {
      for (const tab of tabsRef.current) {
        if (!tab.tmuxSession) continue;
        fetch(`${serverUrl}/api/tmux-sessions/${encodeURIComponent(tab.tmuxSession)}/title`, {
          headers: { 'Authorization': `Bearer ${token}` },
        })
          .then(r => r.json())
          .then(({ title }: { title: string }) => {
            if (title && title !== intentRef.current.get(tab.id)) {
              intentRef.current.set(tab.id, title);
              setTabs(p => p.map(t => t.id === tab.id ? { ...t, lastIntent: title } : t));
            }
          })
          .catch(() => {});
      }
    };
    poll();
    const iv = setInterval(poll, 8000);
    return () => clearInterval(iv);
  }, [tabs.length]);

  const checkedTabs = tabs.filter(t => t.checked);
  const hasChecked = checkedTabs.length > 0;
  const activeTab = tabs.find(t => t.id === activeTabId);

  // Dynamic grid: 1→1, 2→2, 3-4→2, 5-6→3, 7-9→3, 10+→4
  const tileCols = checkedTabs.length <= 2 ? checkedTabs.length
    : checkedTabs.length <= 4 ? 2
    : checkedTabs.length <= 9 ? 3
    : 4;

  // Tile mode: CSS scale to preserve terminal content without any resize.
  // fitAddon.fit() or PTY resize would cause alternate-screen apps (Claude Code)
  // to clear and redraw at idle state, losing visible content. CSS transform:scale()
  // shrinks the full-viewport terminal visually into the tile cell.
  useEffect(() => {
    if (!tileMode || !fontReady) {
      if (!tileMode) {
        setFocusedTileId(null);
        // Restore any inline overrides and refit ALL terminals
        for (const [id, inst] of termInstances) {
          if (inst.term.element) {
            inst.term.element.style.transform = '';
            inst.term.element.style.transformOrigin = '';
            inst.term.element.style.width = '';
            inst.term.element.style.height = '';
          }
          // Fit the active (visible) terminal immediately; others on next tab switch
          if (id === activeTabId) {
            try { inst.fitAddon.fit(); } catch {}
            inst.term.refresh(0, inst.term.rows - 1);
          }
        }
      }
      return;
    }

    let cancelled = false;

    // Auto-set focused tile and sync activeTabId to match
    const checked = tabsRef.current.filter(t => t.checked);
    if (checked.length > 0) {
      setFocusedTileId(prev => {
        if (prev && checked.some(t => t.id === prev)) return prev;
        const active = activeTabIdRef.current;
        if (active && checked.some(t => t.id === active)) return active;
        return checked[0].id;
      });
      const currentActive = activeTabIdRef.current;
      if (!currentActive || !checked.some(t => t.id === currentActive)) {
        setActiveTabId(checked[0].id);
      }
    }

    const scaleTiles = () => {
      if (cancelled) return;
      const checked = tabsRef.current.filter(t => t.checked);

      for (const tab of checked) {
        const container = containerRefs.current.get(tab.id);
        if (!container || !container.isConnected) continue;
        const inst = termInstances.get(tab.id);
        if (!inst?.term.element) continue;

        const termEl = inst.term.element;
        const isAltBuffer = inst.term.buffer.active.type === 'alternate';

        if (isAltBuffer) {
          // Alternate screen (Claude Code TUI, tmux copy mode, etc.):
          // CSS scale to preserve content — any resize would clear the buffer.
          suppressPtyResize = true;
          const screen = termEl.querySelector('.xterm-screen') as HTMLElement | null;
          const naturalW = screen?.offsetWidth || termEl.offsetWidth;
          const naturalH = screen?.offsetHeight || termEl.offsetHeight;

          termEl.style.width = naturalW + 'px';
          termEl.style.height = naturalH + 'px';
          termEl.style.transformOrigin = 'top left';
          termEl.style.overflow = 'hidden';

          const containerW = container.clientWidth;
          const containerH = container.clientHeight;
          if (containerW > 0 && containerH > 0 && naturalW > 0 && naturalH > 0) {
            const scale = Math.min(containerW / naturalW, containerH / naturalH, 1);
            termEl.style.transform = `scale(${scale})`;
          }
          suppressPtyResize = false;
        } else {
          // Normal buffer: fitAddon.fit() for readable font + proper line wrapping.
          // Content lives in scrollback and survives resize.
          termEl.style.transform = '';
          termEl.style.transformOrigin = '';
          termEl.style.width = '';
          termEl.style.height = '';
          termEl.style.overflow = '';
          try { inst.fitAddon.fit(); } catch {}
          inst.term.refresh(0, inst.term.rows - 1);
        }
      }
    };

    // Apply after layout settles (two rAFs for grid to be fully rendered)
    requestAnimationFrame(() => {
      if (!cancelled) requestAnimationFrame(() => {
        if (!cancelled) scaleTiles();
      });
    });

    return () => {
      cancelled = true;
    };
  }, [tileMode, fontReady, checkedTabs.length, activeTabId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Document-level paste handler: catches Cmd/Ctrl+V paste events and sends
  // clipboard text to the focused terminal's WebSocket. This is more reliable
  // than relying on xterm's internal textarea paste, especially when terminals
  // are moved between DOM containers (single ↔ tile mode).
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData('text');
      if (!text) return;
      // Find the active terminal: in tile mode use focusedTileId, else activeTabId
      const targetId = tileMode ? (focusedTileId || activeTabId) : activeTabId;
      if (!targetId) return;
      const inst = termInstances.get(targetId);
      if (inst && inst.ws.readyState === WebSocket.OPEN) {
        e.preventDefault();
        inst.ws.send(text);
      }
    };
    const onCopy = (e: ClipboardEvent) => {
      // If any terminal has a selection, copy it to clipboard
      for (const [, inst] of termInstances) {
        if (inst.term.hasSelection()) {
          e.preventDefault();
          e.clipboardData?.setData('text/plain', inst.term.getSelection());
          return;
        }
      }
    };
    document.addEventListener('paste', onPaste);
    document.addEventListener('copy', onCopy);
    return () => {
      document.removeEventListener('paste', onPaste);
      document.removeEventListener('copy', onCopy);
    };
  }, [tileMode, focusedTileId, activeTabId]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === 't') {
        e.preventDefault();
        if (hasChecked) setTileMode(m => !m);
      } else if (mod && e.shiftKey && e.key === 'L') {
        e.preventDefault();
        fetchTmuxSessions();
      } else if (mod && e.shiftKey && e.key === 'N') {
        e.preventDefault();
        if (aiClis.length > 0) addTab(aiClis[0].name);
        else addTab();
      } else if (mod && e.shiftKey && e.key === 'D') {
        e.preventDefault();
        setShowTodoPanel(prev => !prev);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [hasChecked, aiClis, addTab, fetchTmuxSessions]);

  /** Upload dropped image files to the server and paste their paths into the terminal */
  const handleFileDrop = useCallback(async (tabId: string, files: FileList) => {
    const imageFiles = Array.from(files).filter(f => f.type.startsWith('image/'));
    if (imageFiles.length === 0) return;

    const paths: string[] = [];
    for (const file of imageFiles) {
      try {
        const result = await api.uploadFile(file);
        paths.push(result.path);
      } catch (err) {
        console.error('[DragDrop] Upload failed:', err);
      }
    }

    if (paths.length === 0) return;

    const inst = termInstances.get(tabId);
    if (inst && inst.ws.readyState === WebSocket.OPEN) {
      inst.ws.send(paths.join(' '));
    }
  }, []);

  /** Create drag-drop event handlers for a terminal container element */
  const setupDragDrop = useCallback((el: HTMLElement, tabId: string) => {
    const onDragOver = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
      el.classList.add(DRAG_OVER_CLASS);
    };

    const onDragLeave = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.relatedTarget && el.contains(e.relatedTarget as Node)) return;
      el.classList.remove(DRAG_OVER_CLASS);
    };

    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      el.classList.remove(DRAG_OVER_CLASS);
      if (e.dataTransfer?.files.length) {
        handleFileDrop(tabId, e.dataTransfer.files);
      }
    };

    el.addEventListener('dragover', onDragOver);
    el.addEventListener('dragleave', onDragLeave);
    el.addEventListener('drop', onDrop);

    return () => {
      el.removeEventListener('dragover', onDragOver);
      el.removeEventListener('dragleave', onDragLeave);
      el.removeEventListener('drop', onDrop);
      el.classList.remove(DRAG_OVER_CLASS);
    };
  }, [handleFileDrop]);

  // Attach drag-drop handlers to all visible terminal containers
  useEffect(() => {
    const cleanups: Array<() => void> = [];
    for (const tab of tabs) {
      const el = containerRefs.current.get(tab.id);
      if (el) cleanups.push(setupDragDrop(el, tab.id));
    }
    return () => { for (const cleanup of cleanups) cleanup(); };
  }, [tabs, tileActive, setupDragDrop]);

  // Prevent browser default file drop behavior (navigating to file)
  useEffect(() => {
    const prevent = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
    };
    document.addEventListener('dragover', prevent);
    document.addEventListener('drop', prevent);
    return () => {
      document.removeEventListener('dragover', prevent);
      document.removeEventListener('drop', prevent);
    };
  }, []);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Tab bar */}
      <Box sx={{
        display: 'flex', alignItems: 'center',
        borderBottom: '1px solid', borderColor: 'border.default',
        bg: 'canvas.subtle', height: '36px',
      }}>
        {onBack && (
          <IconButton icon={ArrowLeftIcon} aria-label="Back" variant="invisible" size="small" sx={{ mx: 1 }} onClick={onBack} />
        )}
        <Box sx={{ display: 'flex', overflow: 'auto', minWidth: 0 }}>
          {tabs.map(tab => {
            const inst = termInstances.get(tab.id);
            const isConnected = inst?.connected ?? false;
            const hasConnected = !!inst; // true if WS was ever created
            const isActive = tileMode ? (tab.id === (focusedTileId || activeTabId)) : (tab.id === activeTabId);
            return (
              <Box
                key={tab.id}
                title={tab.lastIntent || tab.name}
                sx={{
                  display: 'flex', alignItems: 'center', gap: 1,
                  px: 2, py: '5px',
                  cursor: 'pointer',
                  borderRight: '1px solid', borderColor: 'border.muted',
                  bg: isActive ? '#1f6feb' : 'transparent',
                  color: isActive ? '#ffffff' : 'fg.default',
                  boxShadow: isActive ? 'inset 0 -3px 0 #58a6ff' : 'none',
                  ':hover': { bg: isActive ? '#1f6feb' : 'canvas.default' },
                  maxWidth: 500, minWidth: 150, flexShrink: 0,
                }}
                onClick={() => { setActiveTabId(tab.id); if (tileMode) { setFocusedTileId(tab.id); const inst = termInstances.get(tab.id); if (inst) inst.term.focus(); } }}
              >
                <input
                  type="checkbox"
                  checked={tab.checked}
                  onChange={() => toggleCheck(tab.id)}
                  onClick={e => e.stopPropagation()}
                  style={{ margin: 0, cursor: 'pointer' }}
                />
                <Box
                  onClick={(e: React.MouseEvent) => { e.stopPropagation(); setActiveTabId(tab.id); if (tileMode) { setFocusedTileId(tab.id); const inst = termInstances.get(tab.id); if (inst) inst.term.focus(); } }}
                  onDoubleClick={(e: React.MouseEvent) => { e.stopPropagation(); setRenamingTabId(tab.id); setRenameValue(tab.name); }}
                  sx={{ display: 'flex', alignItems: 'center', gap: 1, flex: 1, overflow: 'hidden' }}
                >
                  <Box
                    onClick={(e: React.MouseEvent) => { e.stopPropagation(); toggleCheck(tab.id); }}
                    sx={{ width: 6, height: 6, borderRadius: '50%', flexShrink: 0, cursor: 'pointer', bg: isConnected ? 'success.fg' : hasConnected ? 'danger.fg' : 'fg.muted' }}
                  />
                  {renamingTabId === tab.id ? (
                    <input
                      autoFocus
                      value={renameValue}
                      onChange={e => setRenameValue(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') {
                          const trimmed = renameValue.trim();
                          if (trimmed) {
                            setTabs(prev => prev.map(t => t.id === tab.id ? { ...t, name: trimmed, userRenamed: true } : t));
                            setCachedTabName(tab.tmuxSession, trimmed);
                          }
                          setRenamingTabId(null);
                        } else if (e.key === 'Escape') {
                          setRenamingTabId(null);
                        }
                        e.stopPropagation();
                      }}
                      onBlur={() => {
                        const trimmed = renameValue.trim();
                        if (trimmed) {
                          setTabs(prev => prev.map(t => t.id === tab.id ? { ...t, name: trimmed, userRenamed: true } : t));
                          setCachedTabName(tab.tmuxSession, trimmed);
                        }
                        setRenamingTabId(null);
                      }}
                      onClick={e => e.stopPropagation()}
                      style={{
                        fontSize: '11px', fontFamily: 'monospace', background: 'var(--bgColor-default, #0d1117)',
                        color: 'var(--fgColor-default, #e6edf3)', border: '1px solid var(--borderColor-accent-emphasis, #58a6ff)',
                        borderRadius: 3, padding: '1px 4px', outline: 'none', width: '100%', minWidth: 40,
                      }}
                    />
                  ) : (
                    <Text sx={{ fontSize: '11px', color: 'fg.default', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'mono' }}>
                      {tab.name}
                    </Text>
                  )}
                </Box>
                {tab.lastCommand && showTodoPanel && (
                  <Box
                    as="button"
                    onClick={(e: React.MouseEvent) => { e.stopPropagation(); todoDispatcherRef.current.addItem(tab.lastCommand!); }}
                    title={`Queue: ${tab.lastCommand}`}
                    sx={{ bg: 'transparent', border: 'none', color: 'fg.muted', cursor: 'pointer', p: 0, ml: 1, display: 'flex', flexShrink: 0, ':hover': { color: 'accent.fg' } }}
                  >
                    <ListUnorderedIcon size={12} />
                  </Box>
                )}
                {tab.tmuxSession && (
                  <Box
                    as="button"
                    onClick={(e: React.MouseEvent) => { e.stopPropagation(); closeAndTerminateTab(tab.id); }}
                    title="Terminate tmux session"
                    sx={{ bg: 'transparent', border: 'none', color: 'fg.muted', cursor: 'pointer', p: 0, ml: 1, display: 'flex', flexShrink: 0, ':hover': { color: 'danger.fg' } }}
                  >
                    <TrashIcon size={12} />
                  </Box>
                )}
                <Box
                  as="button"
                  onClick={(e: React.MouseEvent) => { e.stopPropagation(); closeTab(tab.id); }}
                  sx={{ bg: 'transparent', border: 'none', color: 'fg.muted', cursor: 'pointer', p: 0, ml: 1, display: 'flex', flexShrink: 0, ':hover': { color: 'danger.fg' } }}
                >
                  <XIcon size={12} />
                </Box>
              </Box>
            );
          })}
        </Box>
        {/* Spacer to push action buttons to center */}
        <Box sx={{ flex: 1 }} />
        {/* Action buttons — centered */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexShrink: 0 }}>
          {/* Swarm mode indicator */}
          <Box sx={{ position: 'relative', display: 'inline-flex' }}>
            <button
              type="button"
              aria-label="Swarm mode"
              title={swarm.enabled ? `Swarm: ${swarm.tunnelUrl || 'no tunnel'}` : 'Swarm mode (disabled)'}
              onClick={() => setShowSwarmPopover(prev => !prev)}
              style={{
                flexShrink: 0,
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                width: 28, height: 28, borderRadius: 6, cursor: 'pointer',
                backgroundColor: swarm.enabled ? 'var(--bgColor-success-emphasis, #238636)' : 'transparent',
                color: swarm.enabled ? 'var(--fgColor-onEmphasis, #fff)' : 'var(--fgColor-muted, #768390)',
                border: 'none', padding: 0,
              }}
            >
              <GlobeIcon size={16} />
            </button>
            {showSwarmPopover && (
              <SwarmPopover
                swarm={swarm}
                onClose={() => setShowSwarmPopover(false)}
              />
            )}
          </Box>
          <button
            type="button"
            aria-label={showTodoPanel ? 'Hide todo queue (⌘⇧D)' : 'Show todo queue (⌘⇧D)'}
            title={showTodoPanel ? 'Hide todo queue (⌘⇧D)' : 'Show todo queue (⌘⇧D)'}
            onClick={() => setShowTodoPanel(prev => !prev)}
            style={{
              flexShrink: 0,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 28, height: 28, borderRadius: 6, cursor: 'pointer',
              backgroundColor: showTodoPanel ? 'var(--bgColor-accent-emphasis, #316dca)' : 'transparent',
              color: showTodoPanel ? 'var(--fgColor-onEmphasis, #fff)' : 'var(--fgColor-muted, #768390)',
              border: 'none', padding: 0,
            }}
          >
            <ListUnorderedIcon size={16} />
          </button>
          <button
            type="button"
            aria-label={tileMode ? 'Single view (⌘T)' : 'Tile checked terminals (⌘T)'}
            title={tileMode ? 'Single view (⌘T)' : 'Tile checked terminals (⌘T)'}
            disabled={!hasChecked}
            onClick={() => setTileMode(m => !m)}
            style={{
              flexShrink: 0, opacity: hasChecked ? 1 : 0.3,
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
              <IconButton icon={LinkIcon} aria-label="Attach tmux session (⌘⇧L)" title="Attach tmux session (⌘⇧L)" variant="invisible" size="small" sx={{ flexShrink: 0, color: 'accent.fg' }} onClick={fetchTmuxSessions} />
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
                      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                        <Text>{s}</Text>
                        <Box
                          as="button"
                          onClick={(e: React.MouseEvent) => { e.stopPropagation(); e.preventDefault(); killTmuxSession(s); }}
                          sx={{ bg: 'transparent', border: 'none', color: 'fg.muted', cursor: 'pointer', p: 0, ml: 2, display: 'flex', ':hover': { color: 'danger.fg' } }}
                          title={`Kill tmux session: ${s}`}
                        >
                          <TrashIcon size={12} />
                        </Box>
                      </Box>
                    </ActionList.Item>
                  ))
                )}
              </ActionList>
            </ActionMenu.Overlay>
          </ActionMenu>
          <ActionMenu>
            <ActionMenu.Anchor>
              <IconButton icon={PlusIcon} aria-label="New terminal (⌘⇧N)" title="New terminal (⌘⇧N)" variant="invisible" size="small" sx={{ flexShrink: 0, color: 'success.fg' }} />
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
        {/* Spacer to balance centering */}
        <Box sx={{ flex: 1 }} />
      </Box>

      {/* Main content: terminal + optional todo panel */}
      <Box sx={{ display: 'flex', flex: 1, minHeight: 0 }}>
      {/* Terminal column */}
      <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>

      {/* Tmux info bar — always rendered with fixed height to prevent layout jitter */}
      {!tileMode && (
        <Box sx={{ px: 2, py: '3px', bg: 'canvas.inset', borderBottom: '1px solid', borderColor: 'border.muted', display: 'flex', alignItems: 'center', gap: 2, height: '24px', visibility: activeTab?.tmuxSession ? 'visible' : 'hidden' }}>
          <Text sx={{ fontSize: '11px', color: 'fg.muted', fontFamily: 'mono' }}>
            tmux attach -t {activeTab?.tmuxSession}
          </Text>
          <Box
            as="button"
            onClick={() => { if (activeTab?.tmuxSession) navigator.clipboard.writeText(`tmux attach -t ${activeTab.tmuxSession}`); }}
            sx={{ bg: 'transparent', border: '1px solid', borderColor: 'border.muted', borderRadius: 1, color: 'fg.muted', cursor: 'pointer', px: 1, py: 0, fontSize: '10px', ':hover': { color: 'fg.default', borderColor: 'border.default' } }}
          >
            copy
          </Box>
        </Box>
      )}

      {/* Terminal area — unified containers, never reparented */}
      <div style={{
        flex: 1, minHeight: 0, minWidth: 0, overflow: 'hidden',
        position: 'relative',
        ...(tileMode && hasChecked ? {
          display: 'grid',
          gridTemplateColumns: `repeat(${tileCols}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${Math.ceil(checkedTabs.length / tileCols)}, minmax(0, 1fr))`,
          gap: '2px',
          background: '#30363d',
        } : {}),
      }}>
        {tabs.map(tab => {
          const isVisible = tileMode && hasChecked
            ? tab.checked
            : tab.id === activeTabId;
          const isTile = tileMode && hasChecked && tab.checked;
          // In single mode, inactive tabs use visibility:hidden (not display:none)
          // so xterm elements maintain full-viewport dimensions for size caching.
          // In tile mode, unchecked tabs use display:none to avoid taking grid cells.
          const isHiddenSingle = !tileMode && tab.id !== activeTabId;
          const isHiddenTile = tileMode && hasChecked && !tab.checked;

          return (
            <div
              key={tab.id}
              style={{
                display: isHiddenTile ? 'none' : 'flex',
                flexDirection: 'column',
                background: '#0d1117',
                minHeight: 0, minWidth: 0, overflow: 'hidden',
                ...(isHiddenSingle ? { visibility: 'hidden', pointerEvents: 'none' } : {}),
                // Single mode: fill entire parent
                ...(!isTile ? {
                  position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
                } : {
                  // Tile mode: grid cell with optional border
                  border: focusedTileId === tab.id ? '2px solid #58a6ff' : '2px solid transparent',
                  borderRadius: focusedTileId === tab.id ? 6 : 0,
                  boxShadow: focusedTileId === tab.id ? '0 0 8px 2px rgba(88,166,255,0.4), inset 0 0 1px rgba(88,166,255,0.3)' : 'none',
                }),
              }}
              onClick={isTile ? () => { const inst = termInstances.get(tab.id); if (inst) { inst.term.focus(); setFocusedTileId(tab.id); } } : undefined}
            >
              {/* Tile header — only in tile mode */}
              {isTile && (
                <div style={{
                  padding: '3px 8px',
                  background: focusedTileId === tab.id ? '#1f6feb' : '#161b22',
                  borderBottom: focusedTileId === tab.id ? '1px solid #388bfd' : '1px solid #21262d',
                  display: 'flex', alignItems: 'center', gap: 4,
                }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', flexShrink: 0, background: termInstances.get(tab.id)?.connected ? '#3fb950' : termInstances.has(tab.id) ? '#f85149' : '#6e7681' }} />
                  <span style={{ fontSize: 10, fontFamily: 'monospace', color: focusedTileId === tab.id ? '#ffffff' : '#8b949e', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {tab.name}
                  </span>
                  {tab.lastIntent && (
                    <span style={{ fontSize: 9, fontStyle: 'italic', color: focusedTileId === tab.id ? '#a5d6ff' : '#58a6ff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      — {tab.lastIntent}
                    </span>
                  )}
                  {tab.lastCommand && showTodoPanel && (
                    <button
                      type="button"
                      title={`Queue: ${tab.lastCommand}`}
                      onClick={(e) => { e.stopPropagation(); todoDispatcherRef.current.addItem(tab.lastCommand!); }}
                      style={{
                        background: 'transparent', border: '1px solid',
                        borderColor: focusedTileId === tab.id ? 'rgba(255,255,255,0.3)' : '#30363d',
                        borderRadius: 3, color: focusedTileId === tab.id ? '#a5d6ff' : '#6e7681',
                        cursor: 'pointer', padding: '0 3px', fontSize: 9, lineHeight: '16px', flexShrink: 0,
                        marginLeft: 'auto',
                      }}
                    >
                      <ListUnorderedIcon size={10} />
                    </button>
                  )}
                  {tab.tmuxSession && (
                    <>
                      <span style={{ fontSize: 9, color: focusedTileId === tab.id ? '#a5d6ff' : '#6e7681', fontFamily: 'monospace', marginLeft: tab.lastCommand && showTodoPanel ? 0 : 'auto', flexShrink: 0 }}>
                        tmux attach -t {tab.tmuxSession}
                      </span>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(`tmux attach -t ${tab.tmuxSession}`); }}
                        style={{
                          background: 'transparent', border: '1px solid',
                          borderColor: focusedTileId === tab.id ? 'rgba(255,255,255,0.3)' : '#30363d',
                          borderRadius: 3, color: focusedTileId === tab.id ? '#a5d6ff' : '#6e7681',
                          cursor: 'pointer', padding: '0 4px', fontSize: 9, lineHeight: '16px', flexShrink: 0,
                        }}
                      >
                        copy
                      </button>
                    </>
                  )}
                </div>
              )}
              {/* Terminal content area */}
              <div
                ref={(el: HTMLDivElement | null) => {
                  if (el) containerRefs.current.set(tab.id, el);
                  else containerRefs.current.delete(tab.id);
                }}
                style={{
                  flex: 1, position: 'relative', minHeight: 0, minWidth: 0, overflow: 'hidden',
                  ...((!isTile) ? { padding: 4 } : {}),
                }}
              />
            </div>
          );
        })}
      </div>

      </Box>{/* end terminal column */}

      {/* Todo queue panel */}
      {showTodoPanel && (
        <TodoPanel
          items={todoDispatcher.items}
          todoMode={todoDispatcher.todoMode}
          tabs={tabs}
          lastCommand={
            (tileActive
              ? tabs.find(t => t.id === focusedTileId)?.lastCommand
              : tabs.find(t => t.id === activeTabId)?.lastCommand
            ) || undefined
          }
          onAddItem={todoDispatcher.addItem}
          onRemoveItem={todoDispatcher.removeItem}
          onRetryItem={todoDispatcher.retryItem}
          onStopRecurring={todoDispatcher.stopRecurring}
          onSetRecurring={todoDispatcher.setRecurring}
          onRunNow={todoDispatcher.runNow}
          onUpdateItemText={todoDispatcher.updateItemText}
          onToggleTodoMode={todoDispatcher.toggleTodoMode}
          onClearCompleted={todoDispatcher.clearCompleted}
          onReorderItem={todoDispatcher.reorderItem}
        />
      )}

      </Box>{/* end main content flex */}
    </Box>
  );
}
