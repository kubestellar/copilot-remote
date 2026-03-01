import { useEffect, useState, useRef } from 'react';
import { Box, Text, Tooltip } from '@primer/react';
import { api } from '../lib/api';

const HEALTH_POLL_MS = 10_000;

interface Props {
  connected: boolean; // WebSocket state
}

export function ConnectionStatus({ connected }: Props) {
  const [apiReachable, setApiReachable] = useState<boolean | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval>>();

  useEffect(() => {
    const check = async () => {
      try {
        await api.health();
        setApiReachable(true);
      } catch (err) {
        console.debug('[ConnectionStatus] Health check failed:', err);
        setApiReachable(false);
      }
    };

    check();
    timerRef.current = setInterval(check, HEALTH_POLL_MS);
    return () => clearInterval(timerRef.current);
  }, []);

  const reachable = apiReachable === true && connected;
  const label = reachable
    ? 'Backend connected'
    : apiReachable === null
      ? 'Checking…'
      : !apiReachable
        ? 'Backend unreachable'
        : 'WebSocket disconnected';

  return (
    <Tooltip text={label} direction="sw">
      <button
        type="button"
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          background: 'none', border: 'none', padding: 0, cursor: 'default',
        }}
      >
        <Box
          sx={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            bg: reachable ? 'success.fg' : 'danger.fg',
            boxShadow: reachable
              ? '0 0 6px var(--bgColor-success-emphasis, #238636)'
              : '0 0 6px var(--bgColor-danger-emphasis, #da3633)',
          }}
        />
        <Text sx={{ fontSize: 0, color: 'fg.muted' }}>
          {reachable ? 'Connected' : apiReachable === null ? 'Checking…' : 'Disconnected'}
        </Text>
      </button>
    </Tooltip>
  );
}
