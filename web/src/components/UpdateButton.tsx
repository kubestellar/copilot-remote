import { useState, useEffect, useCallback, useRef } from 'react';
import { Box, Text, Tooltip } from '@primer/react';
import { SyncIcon } from '@primer/octicons-react';
import { api } from '../lib/api';

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

interface UpdateInfo {
  updateAvailable: boolean;
  currentCommit: string;
  latestCommit: string;
  behindBy: number;
  dirty: boolean;
}

type UpdateState = 'idle' | 'checking' | 'available' | 'applying' | 'done' | 'error';

const SPIN_STYLE = `
@keyframes update-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
`;

export function UpdateButton() {
  const [state, setState] = useState<UpdateState>('idle');
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showPopover, setShowPopover] = useState(false);
  const [spinning, setSpinning] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval>>();
  const popoverRef = useRef<HTMLDivElement>(null);

  const checkUpdate = useCallback(async () => {
    try {
      setState('checking');
      const result = await api.checkUpdate();
      setInfo(result);
      setState(result.updateAvailable ? 'available' : 'idle');
      setError(null);
    } catch (err: any) {
      console.debug('[UpdateButton] Check failed:', err);
      setState('idle');
    }
  }, []);

  useEffect(() => {
    checkUpdate();
    timerRef.current = setInterval(checkUpdate, CHECK_INTERVAL_MS);
    return () => clearInterval(timerRef.current);
  }, [checkUpdate]);

  // Close popover on outside click
  useEffect(() => {
    if (!showPopover) return;
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setShowPopover(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showPopover]);

  const handleApply = useCallback(async () => {
    if (info?.dirty) {
      setError('Cannot update: uncommitted changes on server.');
      return;
    }
    setState('applying');
    setError(null);
    try {
      const result = await api.applyUpdate();
      if (result.success) {
        setState('done');
      } else {
        setState('error');
        setError(result.message);
      }
    } catch (err: any) {
      // Network error is expected when server restarts
      if (state === 'applying') {
        setState('done');
      } else {
        setState('error');
        setError(err.message);
      }
    }
  }, [info]);

  const short = (sha: string) => sha?.slice(0, 7) || '???';

  const dotColor = state === 'available' ? '#f0883e' : state === 'applying' ? '#d29922' : state === 'done' ? '#3fb950' : undefined;

  return (
    <Box sx={{ position: 'relative' }} ref={popoverRef}>
      <Tooltip text={state === 'available' ? `Update available (${info?.behindBy} commit${info?.behindBy === 1 ? '' : 's'} behind)` : state === 'applying' ? 'Updating...' : state === 'done' ? 'Update complete — reload page' : 'Check for updates'} direction="sw">
        <button
          type="button"
          onClick={() => {
            setShowPopover(!showPopover);
            if (!spinning) {
              setSpinning(true);
              checkUpdate().finally(() => setTimeout(() => setSpinning(false), 600));
            }
          }}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            background: 'none', border: 'none', padding: '2px 6px',
            cursor: 'pointer', borderRadius: 6, color: 'inherit',
          }}
          aria-label="Update status"
        >
          <style>{SPIN_STYLE}</style>
          <span style={spinning ? { display: 'inline-flex', animation: 'update-spin 0.6s ease-in-out' } : { display: 'inline-flex' }}>
            <SyncIcon size={16} />
          </span>
          {dotColor && (
            <Box
              sx={{
                position: 'absolute', top: 0, right: 2,
                width: 8, height: 8, borderRadius: '50%',
                bg: dotColor,
                boxShadow: `0 0 6px ${dotColor}`,
              }}
            />
          )}
        </button>
      </Tooltip>

      {showPopover && (
        <Box
          sx={{
            position: 'absolute', top: '100%', right: 0, mt: 1,
            width: 300, p: 3, borderRadius: 2, zIndex: 100,
            bg: 'canvas.overlay', border: '1px solid', borderColor: 'border.default',
            boxShadow: 'shadow.large',
          }}
        >
          <Text sx={{ fontWeight: 'bold', fontSize: 1, display: 'block', mb: 2, color: 'fg.default' }}>
            Server Update
          </Text>

          {state === 'checking' && (
            <Text sx={{ fontSize: 0, color: 'fg.muted' }}>Checking for updates...</Text>
          )}

          {(state === 'idle' || state === 'available') && info && (
            <>
              <Box sx={{ fontSize: 0, mb: 2, color: 'fg.muted' }}>
                <Text sx={{ display: 'block' }}>Current: <code>{short(info.currentCommit)}</code></Text>
                <Text sx={{ display: 'block' }}>Latest: <code>{short(info.latestCommit)}</code></Text>
                {info.updateAvailable && (
                  <Text sx={{ display: 'block', color: 'attention.fg', fontWeight: 'bold', mt: 1 }}>
                    {info.behindBy} commit{info.behindBy === 1 ? '' : 's'} behind
                  </Text>
                )}
                {info.dirty && (
                  <Text sx={{ display: 'block', color: 'danger.fg', mt: 1 }}>
                    ⚠ Uncommitted changes on server
                  </Text>
                )}
              </Box>
              {info.updateAvailable ? (
                <button
                  onClick={handleApply}
                  disabled={info.dirty}
                  style={{
                    width: '100%', padding: '6px 12px', borderRadius: 6,
                    background: info.dirty ? '#21262d' : '#238636',
                    color: '#fff', border: 'none', cursor: info.dirty ? 'not-allowed' : 'pointer',
                    fontWeight: 600, fontSize: 12,
                  }}
                >
                  Update Now
                </button>
              ) : (
                <Text sx={{ fontSize: 0, color: 'success.fg' }}>✓ Up to date with kubestellar/copilot-remote</Text>
              )}
            </>
          )}

          {state === 'applying' && (
            <Box sx={{ textAlign: 'center', py: 2 }}>
              <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block' }}>
                Pulling, installing, and rebuilding...
              </Text>
              <Text sx={{ fontSize: 0, color: 'fg.muted', display: 'block', mt: 1 }}>
                This may take a minute.
              </Text>
            </Box>
          )}

          {state === 'done' && (
            <Box sx={{ textAlign: 'center', py: 2 }}>
              <Text sx={{ fontSize: 0, color: 'success.fg', display: 'block', mb: 2 }}>
                ✓ Update complete
              </Text>
              <button
                onClick={() => window.location.reload()}
                style={{
                  width: '100%', padding: '6px 12px', borderRadius: 6,
                  background: '#238636', color: '#fff', border: 'none',
                  cursor: 'pointer', fontWeight: 600, fontSize: 12,
                }}
              >
                Reload Page
              </button>
            </Box>
          )}

          {error && (
            <Text sx={{ fontSize: 0, color: 'danger.fg', display: 'block', mt: 2 }}>
              {error}
            </Text>
          )}

          {state !== 'applying' && state !== 'done' && (
            <button
              onClick={() => { checkUpdate(); }}
              style={{
                width: '100%', padding: '4px', marginTop: 8, borderRadius: 6,
                background: 'transparent', color: 'var(--fgColor-muted, #8b949e)',
                border: '1px solid var(--borderColor-default, #30363d)',
                cursor: 'pointer', fontSize: 11,
              }}
            >
              Re-check
            </button>
          )}
        </Box>
      )}
    </Box>
  );
}
