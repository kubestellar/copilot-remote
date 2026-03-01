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

export type TodoStatus = 'pending' | 'running' | 'done' | 'failed';

export interface TodoItem {
  id: string;
  description: string;
  status: TodoStatus;
  assignedTileId: string | null;
  assignedTileName: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface WsMessage {
  type: 'output' | 'status' | 'sessions' | 'message' | 'error' | 'stream' | 'tool' | 'turn_complete';
  sessionId?: string;
  data?: string;
  status?: Session['status'];
  sessions?: Session[];
  message?: ChatMessage;
  error?: string;
  timestamp?: string;
  text?: string;
  stopReason?: string;
  tool?: { title?: string; toolCallId?: string; status?: string };
}
