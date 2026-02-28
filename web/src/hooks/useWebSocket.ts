import { useEffect, useRef, useCallback, useState } from 'react';
import type { WsMessage } from '../types';

type MessageHandler = (msg: WsMessage) => void;

export function useWebSocket(onMessage: MessageHandler) {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const reconnectRef = useRef<ReturnType<typeof setTimeout>>();
  const handlersRef = useRef(onMessage);
  handlersRef.current = onMessage;

  const connect = useCallback(() => {
    const token = localStorage.getItem('copilot-remote-token') || '';
    const serverUrl = localStorage.getItem('copilot-remote-server') || '';

    // Determine WebSocket URL
    let wsUrl: string;
    if (serverUrl) {
      const url = new URL(serverUrl);
      wsUrl = `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}/ws?token=${token}`;
    } else {
      const loc = window.location;
      wsUrl = `${loc.protocol === 'https:' ? 'wss:' : 'ws:'}//${loc.host}/ws?token=${token}`;
    }

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
    };

    ws.onmessage = (event) => {
      try {
        const msg: WsMessage = JSON.parse(event.data);
        handlersRef.current(msg);
      } catch (err) {
        console.debug('[WebSocket] Malformed message ignored:', err);
      }
    };

    ws.onclose = () => {
      setConnected(false);
      wsRef.current = null;
      // Auto-reconnect with backoff
      reconnectRef.current = setTimeout(connect, 3000);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, []);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

  const send = useCallback((msg: Record<string, unknown>) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const subscribe = useCallback((sessionId: string) => {
    send({ type: 'subscribe', sessionId });
  }, [send]);

  const unsubscribe = useCallback((sessionId: string) => {
    send({ type: 'unsubscribe', sessionId });
  }, [send]);

  const sendInput = useCallback((sessionId: string, text: string) => {
    send({ type: 'input', sessionId, text });
  }, [send]);

  return { connected, subscribe, unsubscribe, sendInput };
}
