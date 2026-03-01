import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { swarmAuthMiddleware } from './auth.js';
import { validateCommand } from './swarm-blocklist.js';
import { isSwarmEnabled } from './swarm-keys.js';
import { getTodos, setTodos } from './todo-store.js';
import type { TodoItemServer } from './todo-store.js';

/** Maximum characters allowed in a swarm-submitted description */
const SWARM_DESCRIPTION_MAX_LENGTH = 500;

const router = Router();

// Apply swarm auth to all routes except /status
router.use(swarmAuthMiddleware);

/**
 * GET /swarm/api/status — health check (no auth required)
 * Reports whether swarm mode is enabled and basic queue stats.
 */
router.get('/status', (_req, res) => {
  const enabled = isSwarmEnabled();
  const store = getTodos();
  const pendingCount = (store.items || []).filter(i => i.status === 'pending').length;
  const totalCount = (store.items || []).length;
  res.json({ enabled, pendingCount, totalCount });
});

/**
 * GET /swarm/api/todos — read-only queue view (auth required)
 * Returns the current todo queue items.
 */
router.get('/todos', (_req, res) => {
  const store = getTodos();
  res.json({
    items: (store.items || []).map(item => ({
      id: item.id,
      description: item.description,
      status: item.status,
      createdAt: item.createdAt,
      assignedTileName: item.assignedTileName,
    })),
    todoMode: store.todoMode,
  });
});

/**
 * POST /swarm/api/todos — add a new item (auth required)
 * Validates the description against the command blocklist.
 */
router.post('/todos', (req, res) => {
  const { description } = req.body || {};

  if (!description || typeof description !== 'string') {
    res.status(400).json({ error: 'description is required' });
    return;
  }

  const trimmed = description.trim();
  if (trimmed.length === 0) {
    res.status(400).json({ error: 'description cannot be empty' });
    return;
  }

  if (trimmed.length > SWARM_DESCRIPTION_MAX_LENGTH) {
    res.status(400).json({
      error: `description exceeds maximum length of ${SWARM_DESCRIPTION_MAX_LENGTH} characters`,
    });
    return;
  }

  // Validate against command blocklist
  const validation = validateCommand(trimmed);
  if (!validation.allowed) {
    res.status(403).json({
      error: `Blocked: ${validation.description}`,
      pattern: validation.blockedPattern,
      category: validation.category,
    });
    return;
  }

  // Create new todo item
  const store = getTodos();
  const newItem: TodoItemServer = {
    id: uuidv4(),
    description: trimmed,
    status: 'pending',
    assignedTileId: null,
    assignedTileName: null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
  };

  const items = [...(store.items || []), newItem];
  setTodos(items, store.todoMode);

  res.status(201).json({
    id: newItem.id,
    description: newItem.description,
    status: newItem.status,
    createdAt: newItem.createdAt,
    submittedBy: req.swarmKey?.label || 'unknown',
  });
});

export default router;
