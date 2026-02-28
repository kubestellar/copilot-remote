import { useState, useCallback, useEffect, useRef } from 'react';
import { Box, Text } from '@primer/react';
import type { useSwarmStatus } from '../hooks/useSwarmStatus';

/** Width of the swarm popover in pixels */
const POPOVER_WIDTH_PX = 320;

interface SwarmPopoverProps {
  swarm: ReturnType<typeof useSwarmStatus>;
  onClose: () => void;
}

export default function SwarmPopover({ swarm, onClose }: SwarmPopoverProps) {
  const [newKeyLabel, setNewKeyLabel] = useState('');
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [keys, setKeys] = useState<Array<{
    key: string;
    fullKey: string;
    label: string;
    createdAt: string;
    enabled: boolean;
    lastUsedAt: string | null;
  }>>([]);
  const [showKeys, setShowKeys] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Close on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  const handleGenerateKey = useCallback(async () => {
    const trimmed = newKeyLabel.trim();
    if (!trimmed) return;
    const result = await swarm.generateKey(trimmed);
    if (result) {
      setInviteUrl(result.inviteUrl);
      setNewKeyLabel('');
    }
  }, [newKeyLabel, swarm]);

  const handleLoadKeys = useCallback(async () => {
    const k = await swarm.listKeys();
    setKeys(k);
    setShowKeys(true);
  }, [swarm]);

  const handleCopyUrl = useCallback((url: string) => {
    navigator.clipboard.writeText(url);
  }, []);

  return (
    <div
      ref={popoverRef}
      onClick={(e) => e.stopPropagation()}
      style={{
        position: 'absolute',
        top: '100%',
        right: 0,
        marginTop: 4,
        width: POPOVER_WIDTH_PX,
        background: 'var(--bgColor-overlay, #2d333b)',
        border: '1px solid var(--borderColor-default, #444c56)',
        borderRadius: 8,
        boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
        zIndex: 100,
        padding: 12,
      }}
    >
      {/* Header */}
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
        <Text sx={{ fontSize: '13px', fontWeight: 600, color: 'fg.default' }}>Swarm Mode</Text>
        <button
          type="button"
          onClick={() => swarm.toggleEnabled(!swarm.enabled)}
          style={{
            padding: '2px 10px',
            borderRadius: 10,
            border: 'none',
            fontSize: 11,
            fontWeight: 600,
            cursor: 'pointer',
            background: swarm.enabled ? '#238636' : '#30363d',
            color: swarm.enabled ? '#ffffff' : '#8b949e',
          }}
        >
          {swarm.enabled ? 'ON' : 'OFF'}
        </button>
      </Box>

      {/* Tunnel status */}
      <Box sx={{ mb: 2, p: 2, borderRadius: 2, bg: 'canvas.subtle', border: '1px solid', borderColor: 'border.muted' }}>
        <Text sx={{ fontSize: '11px', fontWeight: 600, color: 'fg.muted', display: 'block', mb: 1 }}>
          Tunnel
        </Text>
        {swarm.tunnelRunning && swarm.tunnelUrl ? (
          <Box>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#3fb950', flexShrink: 0 }} />
              <Text sx={{ fontSize: '11px', color: 'success.fg' }}>Connected</Text>
              {swarm.tunnelProvider && (
                <Text sx={{ fontSize: '10px', color: 'fg.muted' }}>({swarm.tunnelProvider})</Text>
              )}
            </Box>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <Text sx={{ fontSize: '11px', fontFamily: 'mono', color: 'fg.default', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                {swarm.tunnelUrl}
              </Text>
              <button
                type="button"
                onClick={() => handleCopyUrl(swarm.tunnelUrl!)}
                style={smallBtnStyle}
              >
                Copy
              </button>
            </Box>
            <button
              type="button"
              onClick={swarm.stopTunnel}
              style={{ ...smallBtnStyle, marginTop: 6, color: '#f85149' }}
            >
              Stop tunnel
            </button>
          </Box>
        ) : (
          <Box>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#6e7681', flexShrink: 0 }} />
              <Text sx={{ fontSize: '11px', color: 'fg.muted' }}>Not running</Text>
            </Box>
            <button
              type="button"
              onClick={swarm.startTunnel}
              disabled={!swarm.enabled}
              style={{
                ...smallBtnStyle,
                opacity: swarm.enabled ? 1 : 0.4,
                cursor: swarm.enabled ? 'pointer' : 'default',
              }}
            >
              Start tunnel
            </button>
          </Box>
        )}
      </Box>

      {/* Keys section */}
      <Box sx={{ mb: 2 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
          <Text sx={{ fontSize: '11px', fontWeight: 600, color: 'fg.muted' }}>
            Invite Keys ({swarm.keyCount})
          </Text>
          <button type="button" onClick={handleLoadKeys} style={smallBtnStyle}>
            {showKeys ? 'Refresh' : 'View'}
          </button>
        </Box>

        {/* Generate new key */}
        <Box sx={{ display: 'flex', gap: 1, mb: 1 }}>
          <input
            type="text"
            placeholder="Label (e.g. Alice)"
            value={newKeyLabel}
            onChange={e => setNewKeyLabel(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleGenerateKey(); e.stopPropagation(); }}
            style={{
              flex: 1,
              padding: '4px 8px',
              borderRadius: 4,
              border: '1px solid var(--borderColor-default, #30363d)',
              background: 'var(--bgColor-default, #0d1117)',
              color: 'var(--fgColor-default, #e6edf3)',
              fontSize: 11,
              outline: 'none',
            }}
          />
          <button
            type="button"
            onClick={handleGenerateKey}
            disabled={!newKeyLabel.trim()}
            style={{
              ...smallBtnStyle,
              background: newKeyLabel.trim() ? '#238636' : '#21262d',
              color: newKeyLabel.trim() ? '#fff' : '#484f58',
            }}
          >
            Generate
          </button>
        </Box>

        {/* Invite URL display */}
        {inviteUrl && (
          <Box sx={{ p: 1, borderRadius: 1, bg: 'success.subtle', border: '1px solid', borderColor: 'success.muted', mb: 1 }}>
            <Text sx={{ fontSize: '10px', fontWeight: 600, color: 'success.fg', display: 'block', mb: '2px' }}>
              Invite link generated!
            </Text>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <Text sx={{ fontSize: '10px', fontFamily: 'mono', color: 'fg.default', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                {inviteUrl}
              </Text>
              <button type="button" onClick={() => handleCopyUrl(inviteUrl)} style={smallBtnStyle}>
                Copy
              </button>
            </Box>
          </Box>
        )}

        {/* Key list */}
        {showKeys && keys.map(k => (
          <Box
            key={k.key}
            sx={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              py: '3px', px: 1, borderBottom: '1px solid', borderColor: 'border.muted',
              fontSize: '10px',
            }}
          >
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
              <span style={{
                width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
                background: k.enabled ? '#3fb950' : '#6e7681',
              }} />
              <Text sx={{ fontWeight: 600, color: 'fg.default', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {k.label}
              </Text>
              <Text sx={{ color: 'fg.muted', fontFamily: 'mono' }}>{k.key}</Text>
            </Box>
            <button
              type="button"
              onClick={() => swarm.revokeKey(k.fullKey)}
              style={{ ...smallBtnStyle, color: '#f85149' }}
            >
              Revoke
            </button>
          </Box>
        ))}
      </Box>

      {/* Error display */}
      {swarm.error && (
        <Text sx={{ fontSize: '10px', color: 'danger.fg', display: 'block' }}>
          {swarm.error}
        </Text>
      )}
    </div>
  );
}

/** Shared small button style */
const smallBtnStyle: React.CSSProperties = {
  padding: '2px 8px',
  borderRadius: 4,
  border: '1px solid var(--borderColor-muted, #21262d)',
  background: 'transparent',
  color: 'var(--fgColor-muted, #8b949e)',
  fontSize: 10,
  cursor: 'pointer',
  flexShrink: 0,
};
