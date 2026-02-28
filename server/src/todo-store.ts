import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const TODO_DIR = join(homedir(), '.copilot-remote');
const TODO_FILE = join(TODO_DIR, 'todo.json');

export interface TodoItemServer {
  id: string;
  description: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  assignedTileId: string | null;
  assignedTileName: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

interface TodoStore {
  items: TodoItemServer[];
  todoMode: boolean;
}

function load(): TodoStore {
  try {
    if (existsSync(TODO_FILE)) {
      return JSON.parse(readFileSync(TODO_FILE, 'utf-8'));
    }
  } catch (err) {
    console.debug('[Todo] Failed to load todo store:', err);
  }
  return { items: [], todoMode: false };
}

function save(store: TodoStore): void {
  if (!existsSync(TODO_DIR)) mkdirSync(TODO_DIR, { recursive: true });
  writeFileSync(TODO_FILE, JSON.stringify(store, null, 2));
}

export function getTodos(): TodoStore {
  return load();
}

export function setTodos(items: TodoItemServer[], todoMode: boolean): void {
  save({ items, todoMode });
}
