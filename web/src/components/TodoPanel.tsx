import { useState, useCallback, useRef, useEffect } from 'react';
import { Box, Text } from '@primer/react';
import { XIcon, SyncIcon, TrashIcon, ChevronUpIcon, ChevronDownIcon, StopIcon, ClockIcon, PlayIcon, CopilotIcon } from '@primer/octicons-react';
import type { TodoItem } from '../types';

/** Default width of the todo panel in pixels */
const TODO_PANEL_DEFAULT_WIDTH_PX = 360;

/** Minimum width the panel can be resized to */
const TODO_PANEL_MIN_WIDTH_PX = 240;

/** Maximum width the panel can be resized to */
const TODO_PANEL_MAX_WIDTH_PX = 700;

/** Width of the drag handle hit area in pixels */
const DRAG_HANDLE_WIDTH_PX = 6;

/** localStorage key for persisting panel width */
const TODO_PANEL_WIDTH_KEY = 'copilot-remote-todo-panel-width';

/** Maximum characters allowed in the todo input */
const TODO_INPUT_MAX_LENGTH = 500;

/** Interval (ms) to update countdown timers in the UI */
const COUNTDOWN_REFRESH_INTERVAL_MS = 1000;

/** Max milliseconds between two Escape presses to trigger clear */
const DOUBLE_ESC_THRESHOLD_MS = 500;

/** Maximum visible lines for todo descriptions before truncation */
const DESCRIPTION_MAX_LINES = 4;

/** Preset interval options for recurring items */
const RECURRING_PRESETS = [
  { label: '5m', ms: 300_000 },
  { label: '15m', ms: 900_000 },
  { label: '30m', ms: 1_800_000 },
  { label: '1h', ms: 3_600_000 },
  { label: '2h', ms: 7_200_000 },
  { label: '6h', ms: 21_600_000 },
  { label: '12h', ms: 43_200_000 },
] as const;

/** Status dot colors mapped to Primer-compatible values */
const STATUS_COLORS: Record<TodoItem['status'], string> = {
  pending: '#6e7681',   // gray — waiting
  running: '#d29922',   // yellow — in progress
  done: '#3fb950',      // green — complete
  failed: '#f85149',    // red — error
};

/** Human-readable status labels */
const STATUS_LABELS: Record<TodoItem['status'], string> = {
  pending: 'Pending',
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
};

/** Format a millisecond duration as a human-readable countdown */
function formatCountdown(ms: number): string {
  if (ms <= 0) return 'now';
  const totalSec = Math.ceil(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min > 0) return `${min}m ${sec}s`;
  return `${sec}s`;
}

/** Format interval preset label from milliseconds */
function formatIntervalLabel(ms: number): string {
  const preset = RECURRING_PRESETS.find(p => p.ms === ms);
  if (preset) return preset.label;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  return `${Math.round(min / 60)}h`;
}

interface TermTab {
  id: string;
  name: string;
}

interface TodoPanelProps {
  items: TodoItem[];
  todoMode: boolean;
  tabs: TermTab[];
  lastCommand?: string;
  onAddItem: (description: string, options?: { recurring?: boolean; intervalMs?: number; maxRuns?: number; skipDispatch?: boolean }) => void;
  onRemoveItem: (id: string) => void;
  onRetryItem: (id: string) => void;
  onStopRecurring: (id: string) => void;
  onSetRecurring: (id: string, intervalMs: number) => void;
  onRunNow: (id: string) => void;
  onUpdateItemText: (id: string, description: string) => void;
  onToggleTodoMode: () => void;
  onClearCompleted: () => void;
  onReorderItem: (id: string, direction: 'up' | 'down') => void;
}

export default function TodoPanel({
  items,
  todoMode,
  tabs: _tabs,
  lastCommand,
  onAddItem,
  onRemoveItem,
  onRetryItem,
  onStopRecurring,
  onSetRecurring,
  onRunNow,
  onUpdateItemText,
  onToggleTodoMode,
  onClearCompleted,
  onReorderItem,
}: TodoPanelProps) {
  const [inputValue, setInputValue] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const lastEscRef = useRef(0);
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState('');
  const [aiSuggestion, setAiSuggestion] = useState('');
  const [aiLoading, setAiLoading] = useState(false);

  // Track which item's schedule picker is open (null = none)
  const [schedulingItemId, setSchedulingItemId] = useState<string | null>(null);

  // Recurring mode state for the input area
  const [recurringEnabled, setRecurringEnabled] = useState(false);
  const [selectedInterval, setSelectedInterval] = useState<number>(RECURRING_PRESETS[1].ms); // default: 5m

  // Tick counter for countdown refresh
  const [, setTick] = useState(0);

  // Resizable width state — persisted to localStorage
  const [panelWidth, setPanelWidth] = useState(() => {
    const saved = localStorage.getItem(TODO_PANEL_WIDTH_KEY);
    const parsed = saved ? parseInt(saved, 10) : NaN;
    return Number.isFinite(parsed) ? Math.max(TODO_PANEL_MIN_WIDTH_PX, Math.min(TODO_PANEL_MAX_WIDTH_PX, parsed)) : TODO_PANEL_DEFAULT_WIDTH_PX;
  });
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef<{ startX: number; startWidth: number } | null>(null);

  // Persist width changes
  useEffect(() => {
    localStorage.setItem(TODO_PANEL_WIDTH_KEY, String(panelWidth));
  }, [panelWidth]);

  // Drag-to-resize handlers
  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragStartRef.current = { startX: e.clientX, startWidth: panelWidth };
    setIsDragging(true);
  }, [panelWidth]);

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!dragStartRef.current) return;
      const delta = dragStartRef.current.startX - e.clientX;
      const newWidth = Math.max(TODO_PANEL_MIN_WIDTH_PX, Math.min(TODO_PANEL_MAX_WIDTH_PX, dragStartRef.current.startWidth + delta));
      setPanelWidth(newWidth);
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      dragStartRef.current = null;
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging]);

  // Refresh countdown display every second when there are scheduled items
  const hasScheduledItems = items.some(i => i.status === 'pending' && i.nextRunAt);
  useEffect(() => {
    if (!hasScheduledItems) return;
    const interval = setInterval(() => setTick(t => t + 1), COUNTDOWN_REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [hasScheduledItems]);

  const pendingCount = items.filter(i => i.status === 'pending').length;
  const runningCount = items.filter(i => i.status === 'running').length;
  const doneCount = items.filter(i => i.status === 'done').length;
  const failedCount = items.filter(i => i.status === 'failed').length;

  const handleSubmit = useCallback(() => {
    const trimmed = inputValue.trim();
    if (!trimmed) return;
    onAddItem(trimmed, recurringEnabled ? {
      recurring: true,
      intervalMs: selectedInterval,
      maxRuns: 0, // unlimited by default
    } : undefined);
    setInputValue('');
    inputRef.current?.focus();
  }, [inputValue, onAddItem, recurringEnabled, selectedInterval]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    } else if (e.key === 'Escape') {
      const now = Date.now();
      if (now - lastEscRef.current < DOUBLE_ESC_THRESHOLD_MS) {
        setInputValue('');
        lastEscRef.current = 0;
      } else {
        lastEscRef.current = now;
      }
    }
    // Prevent terminal from capturing keystrokes
    e.stopPropagation();
  }, [handleSubmit]);

  // Auto-focus input when panel opens
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <Box
      sx={{
        width: panelWidth,
        minWidth: TODO_PANEL_MIN_WIDTH_PX,
        maxWidth: TODO_PANEL_MAX_WIDTH_PX,
        height: '100%',
        display: 'flex',
        flexDirection: 'row',
        bg: 'canvas.default',
        overflow: 'hidden',
        position: 'relative',
        userSelect: isDragging ? 'none' : 'auto',
      }}
    >
      {/* Drag handle on left edge */}
      <div
        onMouseDown={handleDragStart}
        style={{
          width: DRAG_HANDLE_WIDTH_PX,
          cursor: 'col-resize',
          flexShrink: 0,
          background: isDragging ? 'var(--bgColor-accent-emphasis, #316dca)' : 'transparent',
          borderLeft: '1px solid var(--borderColor-default, #30363d)',
          transition: isDragging ? 'none' : 'background 0.15s',
        }}
        onMouseEnter={(e) => { if (!isDragging) (e.currentTarget as HTMLDivElement).style.background = 'var(--borderColor-muted, #21262d)'; }}
        onMouseLeave={(e) => { if (!isDragging) (e.currentTarget as HTMLDivElement).style.background = 'transparent'; }}
        title="Drag to resize"
      />
      {/* Panel content */}
      <Box
        sx={{
          flex: 1,
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
      {/* Header */}
      <Box
        sx={{
          px: 2,
          py: 2,
          borderBottom: '1px solid',
          borderColor: 'border.muted',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 2,
          flexShrink: 0,
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <span style={{ fontSize: 14 }}>☰</span>
          <Text sx={{ fontSize: '12px', fontWeight: 600 }}>Todo Queue</Text>
          {items.length > 0 && (
            <Text sx={{ fontSize: '10px', color: 'fg.muted' }}>({items.length})</Text>
          )}
        </Box>
        <button
          type="button"
          onClick={onToggleTodoMode}
          title={todoMode ? 'Disable auto-dispatch' : 'Enable auto-dispatch'}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '2px 10px',
            borderRadius: 10,
            border: todoMode ? 'none' : '1px solid #6e7681',
            fontSize: 11,
            fontWeight: 600,
            cursor: 'pointer',
            background: todoMode ? '#238636' : '#484f58',
            color: todoMode ? '#ffffff' : '#e6edf3',
            transition: 'background 0.15s',
          }}
        >
          {todoMode ? 'ON' : 'OFF'}
        </button>
      </Box>

      {/* Input */}
      <Box sx={{ px: 2, py: 2, borderBottom: '1px solid', borderColor: 'border.muted', flexShrink: 0 }}>
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start' }}>
          <textarea
            ref={inputRef}
            placeholder="Add command... (Shift+Enter for newline)"
            value={inputValue}
            onChange={e => {
              setInputValue(e.target.value.slice(0, TODO_INPUT_MAX_LENGTH));
              // Auto-grow: reset then set to scrollHeight
              e.target.style.height = 'auto';
              e.target.style.height = `${e.target.scrollHeight}px`;
            }}
            onKeyDown={handleKeyDown}
            rows={3}
            style={{
              flex: 1,
              padding: '6px 8px',
              borderRadius: 6,
              border: '1px solid var(--borderColor-default, #30363d)',
              background: 'var(--bgColor-default, #0d1117)',
              color: 'var(--fgColor-default, #e6edf3)',
              fontSize: 12,
              fontFamily: 'monospace',
              outline: 'none',
              boxSizing: 'border-box',
              minWidth: 0,
              resize: 'none',
              overflow: 'hidden',
              lineHeight: '1.4',
            }}
          />
          {/* Recurring toggle */}
          <button
            type="button"
            onClick={() => setRecurringEnabled(prev => !prev)}
            title={recurringEnabled ? 'Disable recurring' : 'Enable recurring'}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 28,
              height: 28,
              borderRadius: 6,
              border: recurringEnabled ? 'none' : '1px solid var(--borderColor-default, #30363d)',
              background: recurringEnabled ? '#1f6feb' : 'transparent',
              color: recurringEnabled ? '#ffffff' : 'var(--fgColor-muted, #8b949e)',
              cursor: 'pointer',
              fontSize: 14,
              flexShrink: 0,
              transition: 'background 0.15s',
            }}
          >
            <ClockIcon size={14} />
          </button>
        </Box>
        {/* Recurring interval picker — shown when recurring is toggled ON */}
        {recurringEnabled && (
          <Box sx={{ display: 'flex', gap: 1, mt: 1, alignItems: 'center', flexWrap: 'wrap' }}>
            <Text sx={{ fontSize: '10px', color: 'fg.muted' }}>Every:</Text>
            {RECURRING_PRESETS.map(preset => (
              <button
                key={preset.ms}
                type="button"
                onClick={() => setSelectedInterval(preset.ms)}
                onKeyDown={e => e.stopPropagation()}
                style={{
                  padding: '1px 6px',
                  borderRadius: 4,
                  border: selectedInterval === preset.ms ? 'none' : '1px solid var(--borderColor-default, #30363d)',
                  background: selectedInterval === preset.ms ? '#1f6feb' : 'transparent',
                  color: selectedInterval === preset.ms ? '#ffffff' : 'var(--fgColor-muted, #8b949e)',
                  fontSize: 10,
                  cursor: 'pointer',
                }}
              >
                {preset.label}
              </button>
            ))}
          </Box>
        )}
        <Text sx={{ fontSize: '10px', color: 'fg.muted', mt: 1, display: 'block' }}>
          Press Enter to add{recurringEnabled ? ` (every ${formatIntervalLabel(selectedInterval)})` : ''}
        </Text>
        {/* Quick-add last command from the active terminal */}
        {lastCommand && (
          <Box
            sx={{
              mt: '6px',
              display: 'flex',
              alignItems: 'center',
              gap: 1,
              p: '4px 6px',
              borderRadius: 1,
              bg: 'canvas.subtle',
              border: '1px solid',
              borderColor: 'border.muted',
              cursor: 'pointer',
              transition: 'border-color 0.15s',
              ':hover': { borderColor: 'accent.emphasis' },
            }}
            onClick={() => onAddItem(lastCommand, { skipDispatch: true })}
            title={`Add "${lastCommand}" to queue`}
          >
            <Text sx={{ fontSize: '9px', color: 'fg.muted', flexShrink: 0, fontWeight: 600 }}>Last cmd:</Text>
            <Text sx={{ fontSize: '10px', color: 'fg.default', fontFamily: 'mono', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
              {lastCommand}
            </Text>
            <Text sx={{ fontSize: '9px', color: 'accent.fg', flexShrink: 0, fontWeight: 600 }}>+ Add</Text>
          </Box>
        )}
      </Box>

      {/* Item list */}
      <Box sx={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>
        {items.length === 0 ? (
          <Box sx={{ p: 3, textAlign: 'center' }}>
            <Text sx={{ fontSize: '11px', color: 'fg.muted', fontStyle: 'italic' }}>
              No items in queue
            </Text>
          </Box>
        ) : (
          items.map((item, idx) => (
            <Box
              key={item.id}
              sx={{
                px: 2,
                py: '6px',
                borderBottom: '1px solid',
                borderColor: 'border.muted',
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'flex-start',
                gap: '6px',
                bg: item.status === 'running' ? 'attention.subtle' : 'transparent',
                ':hover': { bg: 'canvas.subtle' },
              }}
            >
              {/* Status dot + recurring indicator */}
              <Box sx={{ display: 'flex', alignItems: 'center', gap: '2px', flexShrink: 0, mt: '3px' }}>
                {item.recurring && (
                  <span style={{ fontSize: 10, color: '#1f6feb', lineHeight: 1, display: 'inline-flex' }} title="Recurring"><ClockIcon size={10} /></span>
                )}
                <span
                  title={STATUS_LABELS[item.status]}
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: STATUS_COLORS[item.status],
                    flexShrink: 0,
                  }}
                />
              </Box>

              {/* Content */}
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Text
                  onDoubleClick={() => { setEditingItemId(item.id); setEditingValue(item.description); setAiSuggestion(''); }}
                  title={item.description}
                  sx={{
                    fontSize: '11px',
                    fontFamily: 'mono',
                    color: item.status === 'done' && !item.recurring ? 'fg.muted' : 'fg.default',
                    textDecoration: item.status === 'done' && !item.recurring ? 'line-through' : 'none',
                    wordBreak: 'break-all',
                    display: '-webkit-box',
                    WebkitLineClamp: DESCRIPTION_MAX_LINES,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                    cursor: 'text',
                  }}
                >
                  {item.description}
                </Text>
                {item.status === 'running' && item.assignedTileName && (
                  <Text sx={{ fontSize: '9px', color: 'attention.fg', mt: '2px', display: 'block' }}>
                    running in tab named: {item.assignedTileName}
                  </Text>
                )}
                {item.status === 'failed' && (
                  <Text sx={{ fontSize: '9px', color: 'danger.fg', mt: '2px', display: 'block' }}>
                    Failed
                  </Text>
                )}
                {/* Recurring info line */}
                {item.recurring && (
                  <Text sx={{ fontSize: '9px', color: '#1f6feb', mt: '2px', display: 'block' }}>
                    {(item.runCount ?? 0)}/{item.maxRuns === 0 ? '∞' : item.maxRuns}
                    {item.intervalMs ? ` · every ${formatIntervalLabel(item.intervalMs)}` : ''}
                    {item.status === 'pending' && item.nextRunAt && (
                      <> · next: {formatCountdown(new Date(item.nextRunAt).getTime() - Date.now())}</>
                    )}
                  </Text>
                )}
              </Box>

              {/* Actions */}
              <Box sx={{ display: 'flex', alignItems: 'center', gap: '2px', flexShrink: 0 }}>
                {item.status === 'pending' && !item.nextRunAt && (
                  <>
                    <ActionButton
                      title="Move up"
                      disabled={idx === 0}
                      onClick={() => onReorderItem(item.id, 'up')}
                    >
                      <ChevronUpIcon size={14} />
                    </ActionButton>
                    <ActionButton
                      title="Move down"
                      disabled={idx === items.length - 1}
                      onClick={() => onReorderItem(item.id, 'down')}
                    >
                      <ChevronDownIcon size={14} />
                    </ActionButton>
                  </>
                )}
                {item.status === 'pending' && (item.nextRunAt || item.paused) && (
                  <ActionButton title="Run now" onClick={() => onRunNow(item.id)}>
                    <PlayIcon size={14} />
                  </ActionButton>
                )}
                {(item.status === 'failed' || item.status === 'done') && (
                  <ActionButton title="Re-run" onClick={() => onRetryItem(item.id)}>
                    <SyncIcon size={14} />
                  </ActionButton>
                )}
                {item.recurring ? (
                  <ActionButton title="Stop recurring" onClick={() => onStopRecurring(item.id)}>
                    <StopIcon size={14} />
                  </ActionButton>
                ) : item.status !== 'running' && (
                  <ActionButton
                    title="Set schedule"
                    onClick={() => setSchedulingItemId(prev => prev === item.id ? null : item.id)}
                  >
                    <ClockIcon size={14} />
                  </ActionButton>
                )}
                <ActionButton title="Remove" onClick={() => onRemoveItem(item.id)} danger>
                  <XIcon size={14} />
                </ActionButton>
              </Box>
              {/* Inline schedule picker */}
              {schedulingItemId === item.id && (
                <Box
                  sx={{
                    display: 'flex',
                    gap: 1,
                    mt: '4px',
                    ml: '18px',
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    width: '100%',
                  }}
                >
                  <Text sx={{ fontSize: '10px', color: 'fg.muted' }}>Schedule:</Text>
                  {RECURRING_PRESETS.map(preset => (
                    <button
                      key={preset.ms}
                      type="button"
                      onClick={() => {
                        onSetRecurring(item.id, preset.ms);
                        setSchedulingItemId(null);
                      }}
                      onKeyDown={e => e.stopPropagation()}
                      style={{
                        padding: '1px 6px',
                        borderRadius: 4,
                        border: '1px solid var(--borderColor-default, #30363d)',
                        background: 'transparent',
                        color: 'var(--fgColor-muted, #8b949e)',
                        fontSize: 10,
                        cursor: 'pointer',
                      }}
                    >
                      {preset.label}
                    </button>
                  ))}
                </Box>
              )}
            </Box>
          ))
        )}
      </Box>

      {/* Footer */}
      {items.length > 0 && (
        <Box
          sx={{
            px: 2,
            py: '6px',
            borderTop: '1px solid',
            borderColor: 'border.muted',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexShrink: 0,
          }}
        >
          <Text sx={{ fontSize: '10px', color: 'fg.muted', fontFamily: 'mono' }}>
            {pendingCount}P {runningCount}R {doneCount}D {failedCount}F
          </Text>
          {doneCount > 0 && (
            <button
              type="button"
              onClick={onClearCompleted}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                padding: '2px 6px',
                borderRadius: 4,
                border: '1px solid var(--borderColor-muted, #21262d)',
                background: 'transparent',
                color: 'var(--fgColor-muted, #8b949e)',
                fontSize: 10,
                cursor: 'pointer',
              }}
            >
              <TrashIcon size={10} />
              Clear done
            </button>
          )}
        </Box>
      )}
      </Box>

      {/* Edit Prompt Modal */}
      {editingItemId && (
        <div
          onClick={() => setEditingItemId(null)}
          style={{
            position: 'fixed', inset: 0, zIndex: 9999,
            background: 'rgba(0,0,0,0.6)', display: 'flex',
            alignItems: 'center', justifyContent: 'center',
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            onKeyDown={e => e.stopPropagation()}
            style={{
              background: 'var(--bgColor-default, #0d1117)',
              border: '1px solid var(--borderColor-default, #30363d)',
              borderRadius: 12, padding: 20, width: '90vw', maxWidth: 560,
              maxHeight: '80vh', display: 'flex', flexDirection: 'column', gap: 12,
              boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--fgColor-default, #e6edf3)' }}>
                Edit Prompt
              </span>
              <button
                type="button"
                onClick={() => setEditingItemId(null)}
                style={{
                  background: 'transparent', border: 'none', cursor: 'pointer',
                  color: 'var(--fgColor-muted, #8b949e)', fontSize: 16, padding: '2px 6px',
                }}
              >✕</button>
            </div>
            <textarea
              autoFocus
              value={editingValue}
              onChange={e => setEditingValue(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  const trimmed = editingValue.trim();
                  if (trimmed && editingItemId) { onUpdateItemText(editingItemId, trimmed); }
                  setEditingItemId(null);
                } else if (e.key === 'Escape') {
                  setEditingItemId(null);
                }
                e.stopPropagation();
              }}
              rows={8}
              style={{
                width: '100%', padding: '8px 10px', borderRadius: 6,
                border: '1px solid var(--borderColor-default, #30363d)',
                background: 'var(--bgColor-inset, #010409)',
                color: 'var(--fgColor-default, #e6edf3)',
                fontSize: 12, fontFamily: 'monospace', lineHeight: '1.5',
                outline: 'none', resize: 'vertical', boxSizing: 'border-box',
              }}
            />
            {/* AI suggestion area */}
            {aiSuggestion && (
              <div style={{
                padding: '8px 10px', borderRadius: 6,
                background: 'var(--bgColor-accent-muted, #121d2f)',
                border: '1px solid var(--borderColor-accent-muted, #1f3d5c)',
                fontSize: 11, fontFamily: 'monospace', lineHeight: '1.5',
                color: 'var(--fgColor-default, #e6edf3)',
                maxHeight: 160, overflowY: 'auto', whiteSpace: 'pre-wrap',
              }}>
                <div style={{ fontSize: 10, fontWeight: 600, color: '#58a6ff', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
                  <CopilotIcon size={12} /> AI Suggestion
                </div>
                {aiSuggestion}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between' }}>
              <button
                type="button"
                disabled={aiLoading || !editingValue.trim()}
                onClick={async () => {
                  setAiLoading(true);
                  setAiSuggestion('');
                  try {
                    const base = localStorage.getItem('copilot-remote-server') || '';
                    const token = localStorage.getItem('copilot-remote-token') || '';
                    const resp = await fetch(`${base}/api/improve-prompt`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                      body: JSON.stringify({ prompt: editingValue }),
                    });
                    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                    const data = await resp.json();
                    setAiSuggestion(data.improved || data.error || 'No suggestion returned');
                  } catch (err: any) {
                    setAiSuggestion(`Error: ${err.message}`);
                  } finally {
                    setAiLoading(false);
                  }
                }}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '6px 12px', borderRadius: 6, border: 'none',
                  background: aiLoading ? '#484f58' : '#1f6feb',
                  color: '#ffffff', fontSize: 12, fontWeight: 600,
                  cursor: aiLoading ? 'wait' : 'pointer', opacity: !editingValue.trim() ? 0.4 : 1,
                }}
              >
                <CopilotIcon size={14} />
                {aiLoading ? 'Thinking...' : 'Help from AI'}
              </button>
              <div style={{ display: 'flex', gap: 8 }}>
                {aiSuggestion && (
                  <button
                    type="button"
                    onClick={() => { setEditingValue(aiSuggestion); setAiSuggestion(''); }}
                    style={{
                      padding: '6px 12px', borderRadius: 6,
                      border: '1px solid #1f6feb', background: 'transparent',
                      color: '#58a6ff', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                    }}
                  >
                    Use suggestion
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    const trimmed = editingValue.trim();
                    if (trimmed && editingItemId) { onUpdateItemText(editingItemId, trimmed); }
                    setEditingItemId(null);
                  }}
                  style={{
                    padding: '6px 16px', borderRadius: 6, border: 'none',
                    background: '#238636', color: '#ffffff', fontSize: 12,
                    fontWeight: 600, cursor: 'pointer',
                  }}
                >
                  Save
                </button>
              </div>
            </div>
            <span style={{ fontSize: 10, color: 'var(--fgColor-muted, #6e7681)' }}>
              ⌘+Enter to save · Esc to cancel
            </span>
          </div>
        </div>
      )}
    </Box>
  );
}

/** Small action button for todo item actions */
function ActionButton({
  children,
  title,
  onClick,
  disabled,
  danger,
}: {
  children: React.ReactNode;
  title: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 24,
        height: 24,
        borderRadius: 4,
        border: 'none',
        background: 'transparent',
        color: danger ? 'var(--fgColor-danger, #f85149)' : 'var(--fgColor-muted, #8b949e)',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.3 : 1,
        padding: 0,
      }}
    >
      {children}
    </button>
  );
}
