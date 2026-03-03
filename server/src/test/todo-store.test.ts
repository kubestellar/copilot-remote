/**
 * Tests for todo store — persistence of todo items and todoMode flag.
 *
 * Uses a temp directory to avoid touching real user data.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const tempDir = mkdtempSync(join(tmpdir(), 'todo-test-'));
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tempDir };
});

const { getTodos, setTodos } = await import('../todo-store.js');
type TodoItemServer = import('../todo-store.js').TodoItemServer;

describe('Todo store', () => {
  const todoFile = join(tempDir, '.copilot-remote', 'todo.json');

  afterEach(() => {
    try { rmSync(todoFile); } catch {}
  });

  it('should return empty store when no file exists', () => {
    const store = getTodos();
    expect(store.items).toEqual([]);
    expect(store.todoMode).toBe(false);
  });

  it('should save and retrieve items', () => {
    const item: TodoItemServer = {
      id: 't1',
      description: 'Test task',
      status: 'pending',
      assignedTileId: null,
      assignedTileName: null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
    };
    setTodos([item], true);

    const store = getTodos();
    expect(store.items.length).toBe(1);
    expect(store.items[0].id).toBe('t1');
    expect(store.todoMode).toBe(true);
  });

  it('should persist to disk as JSON', () => {
    setTodos([], true);
    expect(existsSync(todoFile)).toBe(true);
    const raw = JSON.parse(readFileSync(todoFile, 'utf-8'));
    expect(raw.todoMode).toBe(true);
    expect(raw.items).toEqual([]);
  });

  it('should overwrite previous data', () => {
    const item1: TodoItemServer = {
      id: 't1', description: 'First', status: 'done',
      assignedTileId: null, assignedTileName: null,
      createdAt: new Date().toISOString(), startedAt: null, completedAt: null,
    };
    const item2: TodoItemServer = {
      id: 't2', description: 'Second', status: 'pending',
      assignedTileId: null, assignedTileName: null,
      createdAt: new Date().toISOString(), startedAt: null, completedAt: null,
    };

    setTodos([item1], false);
    setTodos([item2], true);

    const store = getTodos();
    expect(store.items.length).toBe(1);
    expect(store.items[0].id).toBe('t2');
    expect(store.todoMode).toBe(true);
  });

  it('should handle recurring todo fields', () => {
    const item: TodoItemServer = {
      id: 'r1', description: 'Recurring check', status: 'pending',
      assignedTileId: 'tile-1', assignedTileName: 'Terminal 1',
      createdAt: new Date().toISOString(), startedAt: null, completedAt: null,
      recurring: true,
      intervalMs: 300_000,
      runCount: 3,
      maxRuns: 10,
      nextRunAt: new Date(Date.now() + 300_000).toISOString(),
    };
    setTodos([item], true);

    const store = getTodos();
    expect(store.items[0].recurring).toBe(true);
    expect(store.items[0].intervalMs).toBe(300_000);
    expect(store.items[0].runCount).toBe(3);
    expect(store.items[0].maxRuns).toBe(10);
    expect(store.items[0].nextRunAt).toBeDefined();
  });

  it('should handle all status values', () => {
    const statuses = ['pending', 'running', 'done', 'failed'] as const;
    const items: TodoItemServer[] = statuses.map((s, i) => ({
      id: `t${i}`, description: `Status: ${s}`, status: s,
      assignedTileId: null, assignedTileName: null,
      createdAt: new Date().toISOString(), startedAt: null, completedAt: null,
    }));
    setTodos(items, false);

    const store = getTodos();
    expect(store.items.map(i => i.status)).toEqual([...statuses]);
  });
});
