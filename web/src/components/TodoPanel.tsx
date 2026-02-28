import { useState, useCallback, useRef, useEffect } from 'react';
import { Box, Text } from '@primer/react';
import { XIcon, SyncIcon, TrashIcon, ChevronUpIcon, ChevronDownIcon } from '@primer/octicons-react';
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

interface TermTab {
  id: string;
  name: string;
}

interface TodoPanelProps {
  items: TodoItem[];
  todoMode: boolean;
  tabs: TermTab[];
  onAddItem: (description: string) => void;
  onRemoveItem: (id: string) => void;
  onRetryItem: (id: string) => void;
  onToggleTodoMode: () => void;
  onClearCompleted: () => void;
  onReorderItem: (id: string, direction: 'up' | 'down') => void;
}

export default function TodoPanel({
  items,
  todoMode,
  tabs: _tabs,
  onAddItem,
  onRemoveItem,
  onRetryItem,
  onToggleTodoMode,
  onClearCompleted,
  onReorderItem,
}: TodoPanelProps) {
  const [inputValue, setInputValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

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
      // Dragging left edge: moving mouse left = wider panel
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

  const pendingCount = items.filter(i => i.status === 'pending').length;
  const runningCount = items.filter(i => i.status === 'running').length;
  const doneCount = items.filter(i => i.status === 'done').length;
  const failedCount = items.filter(i => i.status === 'failed').length;

  const handleSubmit = useCallback(() => {
    const trimmed = inputValue.trim();
    if (!trimmed) return;
    onAddItem(trimmed);
    setInputValue('');
    inputRef.current?.focus();
  }, [inputValue, onAddItem]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSubmit();
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
        // Disable text selection while dragging to avoid annoying highlights
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
            padding: '2px 8px',
            borderRadius: 10,
            border: 'none',
            fontSize: 10,
            fontWeight: 600,
            cursor: 'pointer',
            background: todoMode ? '#238636' : '#30363d',
            color: todoMode ? '#ffffff' : '#8b949e',
            transition: 'background 0.15s',
          }}
        >
          {todoMode ? 'ON' : 'OFF'}
        </button>
      </Box>

      {/* Input */}
      <Box sx={{ px: 2, py: 2, borderBottom: '1px solid', borderColor: 'border.muted', flexShrink: 0 }}>
        <input
          ref={inputRef}
          type="text"
          placeholder="Add command..."
          value={inputValue}
          onChange={e => setInputValue(e.target.value.slice(0, TODO_INPUT_MAX_LENGTH))}
          onKeyDown={handleKeyDown}
          style={{
            width: '100%',
            padding: '6px 8px',
            borderRadius: 6,
            border: '1px solid var(--borderColor-default, #30363d)',
            background: 'var(--bgColor-default, #0d1117)',
            color: 'var(--fgColor-default, #e6edf3)',
            fontSize: 12,
            fontFamily: 'monospace',
            outline: 'none',
            boxSizing: 'border-box',
          }}
        />
        <Text sx={{ fontSize: '10px', color: 'fg.muted', mt: 1, display: 'block' }}>
          Press Enter to add
        </Text>
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
                alignItems: 'flex-start',
                gap: '6px',
                bg: item.status === 'running' ? 'attention.subtle' : 'transparent',
                ':hover': { bg: 'canvas.subtle' },
              }}
            >
              {/* Status dot */}
              <span
                title={STATUS_LABELS[item.status]}
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: STATUS_COLORS[item.status],
                  flexShrink: 0,
                  marginTop: 4,
                }}
              />

              {/* Content */}
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Text
                  sx={{
                    fontSize: '11px',
                    fontFamily: 'mono',
                    color: item.status === 'done' ? 'fg.muted' : 'fg.default',
                    textDecoration: item.status === 'done' ? 'line-through' : 'none',
                    wordBreak: 'break-all',
                    display: 'block',
                  }}
                >
                  {item.description}
                </Text>
                {item.status === 'running' && item.assignedTileName && (
                  <Text sx={{ fontSize: '9px', color: 'attention.fg', mt: '2px', display: 'block' }}>
                    on: {item.assignedTileName}
                  </Text>
                )}
                {item.status === 'failed' && (
                  <Text sx={{ fontSize: '9px', color: 'danger.fg', mt: '2px', display: 'block' }}>
                    Failed
                  </Text>
                )}
              </Box>

              {/* Actions */}
              <Box sx={{ display: 'flex', alignItems: 'center', gap: '2px', flexShrink: 0 }}>
                {item.status === 'pending' && (
                  <>
                    <ActionButton
                      title="Move up"
                      disabled={idx === 0}
                      onClick={() => onReorderItem(item.id, 'up')}
                    >
                      <ChevronUpIcon size={10} />
                    </ActionButton>
                    <ActionButton
                      title="Move down"
                      disabled={idx === items.length - 1}
                      onClick={() => onReorderItem(item.id, 'down')}
                    >
                      <ChevronDownIcon size={10} />
                    </ActionButton>
                  </>
                )}
                {item.status === 'failed' && (
                  <ActionButton title="Retry" onClick={() => onRetryItem(item.id)}>
                    <SyncIcon size={10} />
                  </ActionButton>
                )}
                {item.status !== 'running' && (
                  <ActionButton title="Remove" onClick={() => onRemoveItem(item.id)} danger>
                    <XIcon size={10} />
                  </ActionButton>
                )}
              </Box>
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
        width: 18,
        height: 18,
        borderRadius: 3,
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
