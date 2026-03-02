import { useState, useCallback, useRef, useEffect } from 'react';
import type { TodoItem } from '../types';
import { api } from '../lib/api';

/** localStorage key for todo items */
const TODO_ITEMS_KEY = 'copilot-remote-todo-items';

/** localStorage key for todo mode toggle */
const TODO_MODE_KEY = 'copilot-remote-todo-mode';

/** Debounce interval (ms) for syncing state to the server */
const TODO_SERVER_SYNC_DEBOUNCE_MS = 2000;

/** Interval (ms) for checking if scheduled recurring items are ready to dispatch */
const RECURRING_CHECK_INTERVAL_MS = 15_000;

/** Interval (ms) for polling server to pick up items added via swarm API */
const SERVER_POLL_INTERVAL_MS = 5_000;

/** Delay (ms) between sending command text and pressing Enter.
 *  CLI tools in raw terminal mode (e.g. Claude Code) need the Enter
 *  keystroke as a separate PTY write so it isn't swallowed as part of
 *  the pasted text buffer.  Longer commands need more time for tmux
 *  to finish processing the paste before receiving the Enter. */
const DISPATCH_ENTER_DELAY_MS = 500;

/** Generate a unique todo item ID */
function generateTodoId(): string {
  return `todo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Load items from localStorage */
function loadItems(): TodoItem[] {
  try {
    const raw = localStorage.getItem(TODO_ITEMS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

/** Load todoMode from localStorage */
function loadTodoMode(): boolean {
  return localStorage.getItem(TODO_MODE_KEY) === 'true';
}

interface TermInstance {
  ws: WebSocket;
  connected: boolean;
}

interface TermTab {
  id: string;
  name: string;
  checked?: boolean;
}

export interface TodoDispatcher {
  items: TodoItem[];
  todoMode: boolean;
  addItem: (description: string, options?: { recurring?: boolean; intervalMs?: number; maxRuns?: number }) => void;
  removeItem: (id: string) => void;
  retryItem: (id: string) => void;
  stopRecurring: (id: string) => void;
  setRecurring: (id: string, intervalMs: number) => void;
  runNow: (id: string) => void;
  updateItemText: (id: string, description: string) => void;
  toggleTodoMode: () => void;
  clearCompleted: () => void;
  reorderItem: (id: string, direction: 'up' | 'down') => void;
  onTilePromptReturned: (tileId: string) => void;
  onTileDisconnected: (tileId: string) => void;
}

export function useTodoDispatcher(
  getTermInstances: () => Map<string, TermInstance>,
  tabs: TermTab[],
  activeTabId: string | null,
  tileMode: boolean,
): TodoDispatcher {
  const [items, setItems] = useState<TodoItem[]>(loadItems);
  const [todoMode, setTodoMode] = useState<boolean>(loadTodoMode);

  const itemsRef = useRef(items);
  itemsRef.current = items;

  const todoModeRef = useRef(todoMode);
  todoModeRef.current = todoMode;

  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;

  const tileModeRef = useRef(tileMode);
  tileModeRef.current = tileMode;

  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Persist to localStorage on every change
  useEffect(() => {
    localStorage.setItem(TODO_ITEMS_KEY, JSON.stringify(items));
    localStorage.setItem(TODO_MODE_KEY, String(todoMode));

    // Debounced server sync
    if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    syncTimerRef.current = setTimeout(() => {
      api.saveTodos(items, todoMode).catch(() => {
        /* server sync is best-effort */
      });
    }, TODO_SERVER_SYNC_DEBOUNCE_MS);
  }, [items, todoMode]);

  // Load from server on mount (merge with localStorage)
  useEffect(() => {
    api.getTodos().then(({ items: serverItems, todoMode: serverMode }) => {
      if (serverItems && serverItems.length > 0) {
        const localItems = loadItems();
        // If localStorage is empty, use server data
        if (localItems.length === 0) {
          setItems(serverItems);
          setTodoMode(serverMode);
        }
      }
    }).catch(() => { /* server may be unreachable */ });
  }, []);

  // Poll server for items added via swarm API
  useEffect(() => {
    const interval = setInterval(() => {
      api.getTodos().then(({ items: serverItems }) => {
        setItems(prev => {
          const localIds = new Set(prev.map(i => i.id));
          const newItems = (serverItems || []).filter(i => !localIds.has(i.id));
          if (newItems.length === 0) return prev;
          return [...prev, ...newItems];
        });
      }).catch(() => { /* server may be unreachable */ });
    }, SERVER_POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  /** Dispatch a todo item to a specific tile */
  const dispatchToTile = useCallback((item: TodoItem, tileId: string) => {
    const termInstances = getTermInstances();
    const inst = termInstances.get(tileId);
    if (!inst || !inst.connected || inst.ws.readyState !== WebSocket.OPEN) return;

    const tab = tabsRef.current.find(t => t.id === tileId);

    // Start watching for prompt return BEFORE sending the command so the
    // server is already listening when fast commands complete immediately.
    inst.ws.send(JSON.stringify({ type: 'watch-prompt' }));

    // Send command text first, then Enter as a separate write after a short
    // delay.  CLI tools in raw mode (e.g. Claude Code) process each PTY
    // write as a unit — sending text + \r in a single write can cause the
    // Enter keystroke to be swallowed as part of the paste buffer.
    inst.ws.send(item.description);
    setTimeout(() => {
      if (inst.ws.readyState === WebSocket.OPEN) {
        inst.ws.send('\r');
      }
    }, DISPATCH_ENTER_DELAY_MS);

    // Update item state
    setItems(prev => prev.map(i =>
      i.id === item.id
        ? {
          ...i,
          status: 'running' as const,
          assignedTileId: tileId,
          assignedTileName: tab?.name || tileId,
          startedAt: new Date().toISOString(),
        }
        : i
    ));
  }, [getTermInstances]);

  /** Find first idle VISIBLE tile (connected, no running item assigned).
   *  In single mode only the active tab is eligible.
   *  In tile mode only checked (tiled) tabs are eligible. */
  const findIdleTile = useCallback((): string | null => {
    const termInstances = getTermInstances();
    const currentItems = itemsRef.current;
    const isTile = tileModeRef.current;
    const activeId = activeTabIdRef.current;

    for (const tab of tabsRef.current) {
      // Only dispatch to visible sessions
      if (isTile) {
        // Tile mode: only checked tabs are visible
        if (!tab.checked) continue;
      } else {
        // Single mode: only the active tab is visible
        if (tab.id !== activeId) continue;
      }

      const inst = termInstances.get(tab.id);
      if (!inst || !inst.connected || inst.ws.readyState !== WebSocket.OPEN) continue;

      const hasRunning = currentItems.some(
        i => i.status === 'running' && i.assignedTileId === tab.id
      );
      if (!hasRunning) return tab.id;
    }
    return null;
  }, [getTermInstances]);

  /** Try to dispatch the next pending item to any idle tile */
  const tryDispatchNext = useCallback(() => {
    if (!todoModeRef.current) return;

    const now = Date.now();
    // Find next pending item that is ready to dispatch (not paused, not scheduled for the future)
    const nextPending = itemsRef.current.find(i =>
      i.status === 'pending' && !i.paused && (!i.nextRunAt || new Date(i.nextRunAt).getTime() <= now)
    );
    if (!nextPending) return;

    const idleTile = findIdleTile();
    if (!idleTile) return;

    dispatchToTile(nextPending, idleTile);
  }, [findIdleTile, dispatchToTile]);

  // Timer to check if scheduled recurring items are ready to dispatch
  useEffect(() => {
    const interval = setInterval(() => {
      if (!todoModeRef.current) return;

      const now = Date.now();
      const hasReady = itemsRef.current.some(
        i => i.status === 'pending' && !i.paused && i.nextRunAt && new Date(i.nextRunAt).getTime() <= now
      );
      if (hasReady) {
        tryDispatchNext();
      }
    }, RECURRING_CHECK_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [tryDispatchNext]);

  // Try dispatching whenever pending items exist and terminals may have become
  // available (tabs changed, connections established, page loaded).
  useEffect(() => {
    if (!todoMode) return;
    const hasPending = items.some(i => i.status === 'pending');
    if (!hasPending) return;
    // Short delay to let terminal connections establish after mount
    const timer = setTimeout(() => tryDispatchNext(), 500);
    return () => clearTimeout(timer);
  }, [todoMode, items, tabs, tryDispatchNext]);

  const addItem = useCallback((
    description: string,
    options?: { recurring?: boolean; intervalMs?: number; maxRuns?: number; skipDispatch?: boolean },
  ) => {
    const trimmed = description.trim();
    if (!trimmed) return;

    const newItem: TodoItem = {
      id: generateTodoId(),
      description: trimmed,
      status: 'pending',
      assignedTileId: null,
      assignedTileName: null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      recurring: options?.recurring ?? false,
      intervalMs: options?.intervalMs,
      runCount: 0,
      maxRuns: options?.maxRuns ?? 0,
      nextRunAt: null,
      paused: options?.skipDispatch ?? false,
    };

    setItems(prev => {
      const updated = [...prev, newItem];
      // Schedule dispatch after state updates (unless caller wants to just queue it)
      if (!options?.skipDispatch) {
        setTimeout(() => tryDispatchNext(), 0);
      }
      return updated;
    });
  }, [tryDispatchNext]);

  const removeItem = useCallback((id: string) => {
    setItems(prev => prev.filter(i => i.id !== id));
  }, []);

  const retryItem = useCallback((id: string) => {
    setItems(prev => prev.map(i =>
      i.id === id
        ? { ...i, status: 'pending' as const, assignedTileId: null, assignedTileName: null, startedAt: null, completedAt: null, nextRunAt: null, paused: false }
        : i
    ));
    setTimeout(() => tryDispatchNext(), 0);
  }, [tryDispatchNext]);

  /** Stop recurring for an item (it becomes a one-shot done item) */
  const stopRecurring = useCallback((id: string) => {
    setItems(prev => prev.map(i =>
      i.id === id
        ? { ...i, recurring: false, nextRunAt: null }
        : i
    ));
  }, []);

  /** Enable recurring on an existing item with the given interval */
  const setRecurring = useCallback((id: string, intervalMs: number) => {
    setItems(prev => prev.map(i =>
      i.id === id
        ? { ...i, recurring: true, intervalMs, maxRuns: 0, paused: false }
        : i
    ));
  }, []);

  /** Clear nextRunAt and paused so the item dispatches immediately */
  const runNow = useCallback((id: string) => {
    setItems(prev => prev.map(i =>
      i.id === id
        ? { ...i, nextRunAt: null, paused: false }
        : i
    ));
    setTimeout(() => tryDispatchNext(), 0);
  }, [tryDispatchNext]);

  const toggleTodoMode = useCallback(() => {
    setTodoMode(prev => {
      const next = !prev;
      if (next) {
        // Turning ON — try dispatching immediately
        setTimeout(() => tryDispatchNext(), 0);
      }
      return next;
    });
  }, [tryDispatchNext]);

  const clearCompleted = useCallback(() => {
    setItems(prev => prev.filter(i => i.status !== 'done' || i.recurring));
  }, []);

  const reorderItem = useCallback((id: string, direction: 'up' | 'down') => {
    setItems(prev => {
      const idx = prev.findIndex(i => i.id === id);
      if (idx < 0) return prev;

      const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
      if (swapIdx < 0 || swapIdx >= prev.length) return prev;

      const next = [...prev];
      [next[idx], next[swapIdx]] = [next[swapIdx], next[idx]];
      return next;
    });
  }, []);

  const onTilePromptReturned = useCallback((tileId: string) => {
    // Find the running item assigned to this tile and mark done
    setItems(prev => {
      const updated = prev.map(i => {
        if (i.status !== 'running' || i.assignedTileId !== tileId) return i;

        const newRunCount = (i.runCount ?? 0) + 1;

        // Recurring item: check if it should repeat
        if (i.recurring && (i.maxRuns === 0 || newRunCount < (i.maxRuns ?? 0))) {
          const nextRunAt = i.intervalMs
            ? new Date(Date.now() + i.intervalMs).toISOString()
            : null;
          return {
            ...i,
            status: 'pending' as const,
            assignedTileId: null,
            assignedTileName: null,
            startedAt: null,
            completedAt: new Date().toISOString(),
            runCount: newRunCount,
            nextRunAt,
          };
        }

        // Non-recurring or max runs reached: mark done
        return {
          ...i,
          status: 'done' as const,
          completedAt: new Date().toISOString(),
          runCount: newRunCount,
          recurring: i.recurring && newRunCount >= (i.maxRuns ?? 0) ? false : i.recurring,
        };
      });

      // After marking done/re-pending, try dispatching next pending item
      if (todoModeRef.current) {
        setTimeout(() => tryDispatchNext(), 0);
      }

      return updated;
    });
  }, [tryDispatchNext]);

  const onTileDisconnected = useCallback((tileId: string) => {
    setItems(prev => prev.map(i =>
      i.status === 'running' && i.assignedTileId === tileId
        ? { ...i, status: 'failed' as const, completedAt: new Date().toISOString() }
        : i
    ));
  }, []);

  /** Update the description text of a todo item */
  const updateItemText = useCallback((id: string, description: string) => {
    setItems(prev => prev.map(i => i.id === id ? { ...i, description } : i));
  }, []);

  return {
    items,
    todoMode,
    addItem,
    removeItem,
    retryItem,
    stopRecurring,
    setRecurring,
    runNow,
    toggleTodoMode,
    clearCompleted,
    reorderItem,
    updateItemText,
    onTilePromptReturned,
    onTileDisconnected,
  };
}
