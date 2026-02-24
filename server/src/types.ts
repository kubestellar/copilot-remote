export interface Session {
  id: string;
  cwd: string;
  summary?: string;
  status: 'running' | 'active' | 'idle' | 'exited';
  createdAt: string;
  updatedAt: string;
  pid?: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'copilot' | 'system';
  content: string;
  timestamp: string;
}

export interface CreateSessionRequest {
  prompt?: string;
  cwd?: string;
  resume?: string; // session ID to resume
}

export interface WsMessage {
  type: 'subscribe' | 'unsubscribe' | 'input' | 'resize';
  sessionId?: string;
  text?: string;
  cols?: number;
  rows?: number;
}

export interface WsServerMessage {
  type: 'output' | 'status' | 'sessions' | 'message' | 'error';
  sessionId?: string;
  data?: string;
  status?: Session['status'];
  sessions?: Session[];
  message?: ChatMessage;
  error?: string;
  timestamp?: string;
}
