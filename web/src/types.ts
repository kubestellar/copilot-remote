export interface Session {
  id: string;
  cwd: string;
  summary?: string;
  name?: string;
  tags?: string[];
  status: 'running' | 'active' | 'idle' | 'exited';
  createdAt: string;
  updatedAt: string;
  pid?: number;
  messages?: ChatMessage[];
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'copilot' | 'system';
  content: string;
  timestamp: string;
}

export interface WsMessage {
  type: 'output' | 'status' | 'sessions' | 'message' | 'error';
  sessionId?: string;
  data?: string;
  status?: Session['status'];
  sessions?: Session[];
  message?: ChatMessage;
  error?: string;
  timestamp?: string;
}
