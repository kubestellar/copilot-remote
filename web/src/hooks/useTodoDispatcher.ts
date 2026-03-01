import { useState, useCallback, useRef, useEffect } from 'react';
import type { TodoItem } from '../types';
import { api } from '../lib/api';

/** localStorage key for todo items */
const TODO_ITEMS_KEY = 'copilot-remote-todo-items';

/** localStorage key for todo mode toggle */
const TODO_MODE_KEY = 'copilot-remote-todo-mode';

/** Debounce interval (ms) for syncing state to the server */
const TODO_SERVER_SYNC_DEBOUNCE_MS = 2000;

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
}

export interface TodoDispatcher {
  items: TodoItem[];
  todoMode: boolean;
  addItem: (description: string) => void;
  removeItem: (id: string) => void;
  retryItem: (id: string) => void;
  toggleTodoMode: () => void;
  clearCompleted: () => void;
  reorderItem: (id: string, direction: 'up' | 'down') => void;
  onTilePromptReturned: (tileId: string) => void;
  onTileDisconnected: (tileId: string) => void;
}

export function useTodoDispatcher(
  getTermInstances: () => Map<string, TermInstance>,
  tabs: TermTab[],
): TodoDispatcher {
  const [items, setItems] = useState<TodoItem[]>(loadItems);
  const [todoMode, setTodoMode] = useState<boolean>(loadTodoMode);

  const itemsRef = useRef(items);
  itemsRef.current = items;

  const todoModeRef = useRef(todoMode);
  todoModeRef.current = todoMode;

  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

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

  /** Dispatch a todo item to a specific tile */
  const dispatchToTile = useCallback((item: TodoItem, tileId: string) => {
    const termInstances = getTermInstances();
    const inst = termInstances.get(tileId);
    if (!inst || !inst.connected || inst.ws.readyState !== WebSocket.OPEN) return;

    const tab = tabsRef.current.find(t => t.id === tileId);

    // Send the command to the terminal
    inst.ws.send(item.description + '\r');

    // Tell the server to start watching for prompt return
    inst.ws.send(JSON.stringify({ type: 'watch-prompt' }));

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

  /** Find first idle tile (connected, no running item assigned) */
  const findIdleTile = useCallback((): string | null => {
    const termInstances = getTermInstances();
    const currentItems = itemsRef.current;

    for (const tab of tabsRef.current) {
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

    const nextPending = itemsRef.current.find(i => i.status === 'pending');
    if (!nextPending) return;

    const idleTile = findIdleTile();
    if (!idleTile) return;

    dispatchToTile(nextPending, idleTile);
  }, [findIdleTile, dispatchToTile]);

  const addItem = useCallback((description: string) => {
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
    };

    setItems(prev => {
      const updated = [...prev, newItem];
      // Schedule dispatch after state updates
      setTimeout(() => tryDispatchNext(), 0);
      return updated;
    });
  }, [tryDispatchNext]);

  const removeItem = useCallback((id: string) => {
    setItems(prev => prev.filter(i => i.id !== id));
  }, []);

  const retryItem = useCallback((id: string) => {
    setItems(prev => prev.map(i =>
      i.id === id
        ? { ...i, status: 'pending' as const, assignedTileId: null, assignedTileName: null, startedAt: null, completedAt: null }
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
    setItems(prev => prev.filter(i => i.status !== 'done'));
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
      const updated = prev.map(i =>
        i.status === 'running' && i.assignedTileId === tileId
          ? { ...i, status: 'done' as const, completedAt: new Date().toISOString() }
          : i
      );

      // After marking done, try dispatching next pending item
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

  return {
    items,
    todoMode,
    addItem,
    removeItem,
    retryItem,
    toggleTodoMode,
    clearCompleted,
    reorderItem,
    onTilePromptReturned,
    onTileDisconnected,
  };
}
