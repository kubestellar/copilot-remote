import { useState, useEffect, useCallback } from 'react';

/** Interval for polling swarm status (ms) */
const SWARM_STATUS_POLL_INTERVAL_MS = 5_000;

export interface SwarmStatus {
  enabled: boolean;
  keyCount: number;
  tunnelUrl: string | null;
  tunnelRunning: boolean;
  tunnelProvider: string | null;
  loading: boolean;
  error: string | null;
}

interface SwarmKeyInfo {
  key: string;
  fullKey: string;
  label: string;
  createdAt: string;
  enabled: boolean;
  lastUsedAt: string | null;
}

const getToken = () => localStorage.getItem('copilot-remote-token') || '';
const getBaseUrl = () => localStorage.getItem('copilot-remote-server') || '';

async function swarmRequest<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${getBaseUrl()}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getToken()}`,
      ...opts?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export function useSwarmStatus() {
  const [status, setStatus] = useState<SwarmStatus>({
    enabled: false,
    keyCount: 0,
    tunnelUrl: null,
    tunnelRunning: false,
    tunnelProvider: null,
    loading: true,
    error: null,
  });

  const refresh = useCallback(async () => {
    try {
      const data = await swarmRequest<{
        enabled: boolean;
        keyCount: number;
        tunnelUrl: string | null;
        tunnelRunning: boolean;
        tunnelProvider: string | null;
      }>('/api/swarm/status');
      setStatus(prev => ({ ...prev, ...data, loading: false, error: null }));
    } catch (err: any) {
      setStatus(prev => ({ ...prev, loading: false, error: err.message }));
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, SWARM_STATUS_POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [refresh]);

  const toggleEnabled = useCallback(async (enabled: boolean) => {
    try {
      await swarmRequest('/api/swarm/enabled', {
        method: 'PUT',
        body: JSON.stringify({ enabled }),
      });
      refresh();
    } catch (err: any) {
      setStatus(prev => ({ ...prev, error: err.message }));
    }
  }, [refresh]);

  const generateKey = useCallback(async (label: string): Promise<{ inviteUrl: string } | null> => {
    try {
      const result = await swarmRequest<{ inviteUrl: string }>('/api/swarm/keys', {
        method: 'POST',
        body: JSON.stringify({ label }),
      });
      refresh();
      return result;
    } catch (err: any) {
      setStatus(prev => ({ ...prev, error: err.message }));
      return null;
    }
  }, [refresh]);

  const listKeys = useCallback(async (): Promise<SwarmKeyInfo[]> => {
    try {
      return await swarmRequest<SwarmKeyInfo[]>('/api/swarm/keys');
    } catch {
      return [];
    }
  }, []);

  const revokeKey = useCallback(async (key: string) => {
    try {
      await swarmRequest(`/api/swarm/keys/${key}`, { method: 'DELETE' });
      refresh();
    } catch (err: any) {
      setStatus(prev => ({ ...prev, error: err.message }));
    }
  }, [refresh]);

  const startTunnel = useCallback(async () => {
    try {
      await swarmRequest('/api/swarm/tunnel/start', { method: 'POST' });
      refresh();
    } catch (err: any) {
      setStatus(prev => ({ ...prev, error: err.message }));
    }
  }, [refresh]);

  const stopTunnel = useCallback(async () => {
    try {
      await swarmRequest('/api/swarm/tunnel/stop', { method: 'POST' });
      refresh();
    } catch (err: any) {
      setStatus(prev => ({ ...prev, error: err.message }));
    }
  }, [refresh]);

  return {
    ...status,
    refresh,
    toggleEnabled,
    generateKey,
    listKeys,
    revokeKey,
    startTunnel,
    stopTunnel,
  };
}
