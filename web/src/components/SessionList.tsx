import { useState, useCallback } from 'react';
import { Box, Text, ActionList, Button, Spinner, Label, RelativeTime, TextInput } from '@primer/react';
import { PlusIcon, SyncIcon, PencilIcon, XIcon, TagIcon, ChevronDownIcon, ChevronRightIcon, TrashIcon } from '@primer/octicons-react';
import { api } from '../lib/api';
import type { Session } from '../types';

const TAG_COLORS: Record<string, { bg: string; fg: string }> = {
  kubestellar: { bg: '#1f6feb33', fg: '#58a6ff' },
  clubtivi: { bg: '#f7830833', fg: '#f78308' },
  infra: { bg: '#8b949e33', fg: '#8b949e' },
  bug: { bg: '#da363333', fg: '#f85149' },
  feature: { bg: '#23863633', fg: '#3fb950' },
  docs: { bg: '#a371f733', fg: '#bc8cff' },
};

function getTagStyle(tag: string) {
  const lower = tag.toLowerCase();
  for (const [key, style] of Object.entries(TAG_COLORS)) {
    if (lower.includes(key)) return style;
  }
  return { bg: '#30363d', fg: '#8b949e' };
}

interface Props {
  sessions: Session[];
  loading: boolean;
  error: string | null;
  activeId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onNew: () => void;
  onRefresh: () => void;
  onEditingChange?: (editing: boolean) => void;
}

export function SessionList({ sessions, loading, error, activeId, onSelect, onDelete, onNew, onRefresh, onEditingChange }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [copilotCollapsed, setCopilotCollapsed] = useState(false);
  const [editName, setEditName] = useState('');
  const [addingTagId, setAddingTagId] = useState<string | null>(null);
  const [newTag, setNewTag] = useState('');

  // Notify parent when editing state changes to pause polling
  const setEditing = useCallback((id: string | null) => {
    setEditingId(id);
    onEditingChange?.(id !== null);
  }, [onEditingChange]);

  const setAddingTag = useCallback((id: string | null) => {
    setAddingTagId(id);
    onEditingChange?.(id !== null);
  }, [onEditingChange]);

  const statusColor = (s: Session['status']) => {
    switch (s) {
      case 'running': return 'success.fg';
      case 'active': return 'success.fg';
      case 'idle': return 'attention.fg';
      case 'exited': return 'fg.muted';
    }
  };

  const statusLabel = (s: Session['status']) => {
    switch (s) {
      case 'running': return 'Running';
      case 'active': return 'Active';
      case 'idle': return 'Idle';
      case 'exited': return 'Ended';
    }
  };

  const handleStartRename = useCallback((e: React.MouseEvent, session: Session) => {
    e.stopPropagation();
    setEditing(session.id);
    setEditName(session.name || session.summary || '');
  }, [setEditing]);

  const handleSaveRename = useCallback(async (sessionId: string) => {
    await api.updateSessionMeta(sessionId, { name: editName.trim() || undefined });
    onRefresh();
    setEditing(null);
  }, [editName, onRefresh, setEditing]);

  const handleAddTag = useCallback(async (sessionId: string) => {
    if (newTag.trim()) {
      await api.addTag(sessionId, newTag.trim());
      onRefresh();
    }
    setNewTag('');
    setAddingTag(null);
  }, [newTag, onRefresh, setAddingTag]);

  const handleRemoveTag = useCallback(async (e: React.MouseEvent, sessionId: string, tag: string) => {
    e.stopPropagation();
    await api.removeTag(sessionId, tag);
    onRefresh();
  }, [onRefresh]);

  const displayName = (s: Session) => s.name || s.summary || s.cwd.split('/').pop() || s.id.slice(0, 8);

  return (
    <Box sx={{ p: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', mb: 2, gap: 1 }}>
        <Text sx={{ fontWeight: 'bold', fontSize: 1, color: 'fg.default', flex: 1 }}>Sessions</Text>
        <Button size="small" leadingVisual={SyncIcon} onClick={onRefresh} variant="invisible" aria-label="Refresh" />
        <Button size="small" leadingVisual={PlusIcon} onClick={onNew} variant="primary">New</Button>
      </Box>

      {loading && <Box sx={{ textAlign: 'center', py: 4 }}><Spinner size="small" /></Box>}
      {error && <Text sx={{ color: 'danger.fg', fontSize: 0 }}>{error}</Text>}

      <ActionList>
        <ActionList.Group>
          <ActionList.GroupHeading as="h3" sx={{ fontSize: '11px', fontWeight: 600, color: 'fg.muted', textTransform: 'uppercase', letterSpacing: '0.5px', cursor: 'pointer', userSelect: 'none' }} onClick={() => setCopilotCollapsed(!copilotCollapsed)}>
            {copilotCollapsed ? <ChevronRightIcon size={12} /> : <ChevronDownIcon size={12} />}{' '}
            ⚡ Copilot{' '}
            <span style={{ fontWeight: 400 }}>
              {sessions.filter(s => s.status === 'running' || s.status === 'active').length}/{sessions.length}
            </span>
          </ActionList.GroupHeading>
        {!copilotCollapsed && sessions.map(session => (
          <ActionList.Item
            key={session.id}
            active={session.id === activeId}
            onSelect={() => onSelect(session.id)}
          >
            <ActionList.LeadingVisual>
              <Box sx={{ width: 8, height: 8, borderRadius: '50%', bg: statusColor(session.status) }} />
            </ActionList.LeadingVisual>
            <Box sx={{ overflow: 'hidden', width: '100%' }}>
              {editingId === session.id ? (
                <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }} onClick={e => e.stopPropagation()}>
                  <TextInput
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleSaveRename(session.id); if (e.key === 'Escape') setEditing(null); }}
                    onBlur={() => handleSaveRename(session.id)}
                    size="small"
                    sx={{ flex: 1, fontSize: 0, bg: 'canvas.default', color: 'fg.default' }}
                    autoFocus
                  />
                  <Button size="small" variant="primary" onClick={() => handleSaveRename(session.id)} sx={{ fontSize: 0, py: 0, px: 2 }}>
                    Save
                  </Button>
                </Box>
              ) : (
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <Text sx={{ fontSize: 0, fontWeight: session.id === activeId ? 'bold' : 'normal', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                    {displayName(session)}
                  </Text>
                  <Box
                    as="button"
                    sx={{ bg: 'transparent', border: 'none', color: 'fg.muted', cursor: 'pointer', p: 0, display: 'flex', flexShrink: 0, ':hover': { color: 'fg.default' } }}
                    onClick={(e: React.MouseEvent) => handleStartRename(e, session)}
                    aria-label="Rename"
                  >
                    <PencilIcon size={12} />
                  </Box>
                  <Box
                    as="button"
                    sx={{ bg: 'transparent', border: 'none', color: 'fg.muted', cursor: 'pointer', p: 0, display: 'flex', flexShrink: 0, ':hover': { color: 'danger.fg' } }}
                    onClick={(e: React.MouseEvent) => { e.stopPropagation(); onDelete(session.id); }}
                    aria-label="Delete session"
                  >
                    <TrashIcon size={12} />
                  </Box>
                </Box>
              )}
              <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'nowrap', overflow: 'hidden' }}>
                <Label variant={session.status === 'running' || session.status === 'active' ? 'success' : 'secondary'} sx={{ fontSize: '10px', py: 0, lineHeight: '16px' }}>
                  {statusLabel(session.status)}
                </Label>
                {(session.tags || []).map(tag => {
                  const style = getTagStyle(tag);
                  return (
                    <Box
                      key={tag}
                      sx={{ display: 'inline-flex', alignItems: 'center', gap: '2px', px: '5px', borderRadius: '8px', fontSize: '10px', fontWeight: 600, bg: style.bg, color: style.fg, lineHeight: '16px', flexShrink: 0 }}
                    >
                      {tag}
                      <Box
                        as="button"
                        sx={{ bg: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', p: 0, display: 'flex', opacity: 0.7, ':hover': { opacity: 1 } }}
                        onClick={(e: React.MouseEvent) => handleRemoveTag(e, session.id, tag)}
                      >
                        <XIcon size={8} />
                      </Box>
                    </Box>
                  );
                })}
                {addingTagId === session.id ? (
                  <Box onClick={e => e.stopPropagation()}>
                    <input
                      value={newTag}
                      onChange={e => setNewTag(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') handleAddTag(session.id); if (e.key === 'Escape') { setAddingTag(null); setNewTag(''); } }}
                      placeholder="tag"
                      autoFocus
                      style={{ width: 50, fontSize: 10, padding: '1px 4px', borderRadius: 4, border: '1px solid #444c56', background: '#161b22', color: '#e6edf3' }}
                    />
                  </Box>
                ) : (
                  <Box
                    as="button"
                    sx={{ bg: 'transparent', border: 'none', color: 'fg.muted', cursor: 'pointer', p: 0, display: 'flex', flexShrink: 0, ':hover': { color: 'fg.default' } }}
                    onClick={(e: React.MouseEvent) => { e.stopPropagation(); setAddingTagId(session.id); }}
                    aria-label="Add tag"
                  >
                    <TagIcon size={10} />
                  </Box>
                )}
                <Text sx={{ color: 'fg.muted', fontSize: '10px', whiteSpace: 'nowrap', flexShrink: 0 }}>
                  <RelativeTime date={new Date(session.updatedAt)} />
                </Text>
              </Box>
            </Box>
          </ActionList.Item>
        ))}
        {!copilotCollapsed && !loading && sessions.length === 0 && (
          <Text sx={{ color: 'fg.muted', fontSize: 1, p: 3, textAlign: 'center', display: 'block' }}>
            No sessions found
          </Text>
        )}
        </ActionList.Group>

        {/* Future: Claude, Gemini, etc. groups go here */}

      </ActionList>
    </Box>
  );
}
