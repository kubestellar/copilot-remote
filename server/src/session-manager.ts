import { EventEmitter } from 'events';
import { spawn, ChildProcess } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import type { Session, ChatMessage } from './types.js';
import { listHistoricalSessions } from './session-store.js';

interface ManagedSession {
  session: Session;
  proc: ChildProcess | null;
  messages: ChatMessage[];
  buffer: string;
}

class SessionManager extends EventEmitter {
  private sessions = new Map<string, ManagedSession>();

  getAllSessions(): Session[] {
    const running = Array.from(this.sessions.values()).map(s => s.session);
    const historical = listHistoricalSessions();
    const runningIds = new Set(running.map(s => s.id));
    const merged = [
      ...running,
      ...historical.filter(h => !runningIds.has(h.id)),
    ];
    return merged;
  }

  getSession(id: string): ManagedSession | undefined {
    return this.sessions.get(id);
  }

  getMessages(id: string): ChatMessage[] {
    return this.sessions.get(id)?.messages || [];
  }

  async createSession(opts: { prompt?: string; cwd?: string; resume?: string }): Promise<Session> {
    const id = opts.resume || uuidv4();

    // Kill existing managed process if any
    const existing = this.sessions.get(id);
    if (existing?.proc) {
      try { existing.proc.kill(); } catch (killErr) { console.debug('[Session] Failed to kill existing process:', killErr); }
      existing.proc = null;
    }

    const args: string[] = [];
    if (opts.resume) {
      args.push('--resume', opts.resume);
    }
    if (opts.prompt) {
      args.push('-p', opts.prompt);
    }

    const copilotPath = process.env.COPILOT_PATH || 'copilot';
    const cwd = opts.cwd || process.env.HOME || '/';

    const proc = spawn(copilotPath, args, {
      cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const session: Session = {
      id,
      cwd,
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      pid: proc.pid,
    };

    const managed: ManagedSession = {
      session,
      proc,
      messages: [],
      buffer: '',
    };

    this.sessions.set(id, managed);

    const handleData = (data: Buffer) => {
      const text = data.toString();
      managed.buffer += text;
      managed.session.updatedAt = new Date().toISOString();
      this.emit('output', id, text);
      this.parseBuffer(managed);
    };

    proc.stdout?.on('data', handleData);
    proc.stderr?.on('data', handleData);

    proc.on('exit', (exitCode) => {
      managed.session.status = 'exited';
      managed.proc = null;
      this.emit('status', id, 'exited');

      const sysMsg: ChatMessage = {
        id: uuidv4(),
        role: 'system',
        content: `Session exited with code ${exitCode ?? 'unknown'}`,
        timestamp: new Date().toISOString(),
      };
      managed.messages.push(sysMsg);
      this.emit('message', id, sysMsg);
    });

    proc.on('error', (err) => {
      managed.session.status = 'exited';
      managed.proc = null;
      this.emit('status', id, 'exited');

      const sysMsg: ChatMessage = {
        id: uuidv4(),
        role: 'system',
        content: `Failed to start: ${err.message}`,
        timestamp: new Date().toISOString(),
      };
      managed.messages.push(sysMsg);
      this.emit('message', id, sysMsg);
    });

    if (opts.prompt) {
      const userMsg: ChatMessage = {
        id: uuidv4(),
        role: 'user',
        content: opts.prompt,
        timestamp: new Date().toISOString(),
      };
      managed.messages.push(userMsg);
      this.emit('message', id, userMsg);
    }

    return session;
  }

  sendInput(id: string, text: string): boolean {
    const managed = this.sessions.get(id);
    if (!managed) return false;

    // If the process is dead or stdin not writable, re-resume with new prompt
    if (!managed.proc?.stdin?.writable) {
      this.createSession({ resume: id, prompt: text });
      return true;
    }

    managed.proc.stdin.write(text + '\n');

    const userMsg: ChatMessage = {
      id: uuidv4(),
      role: 'user',
      content: text,
      timestamp: new Date().toISOString(),
    };
    managed.messages.push(userMsg);
    this.emit('message', id, userMsg);

    return true;
  }

  killSession(id: string): boolean {
    const managed = this.sessions.get(id);
    if (!managed?.proc) return false;
    managed.proc.kill('SIGTERM');
    return true;
  }

  private parseBuffer(managed: ManagedSession): void {
    if ((managed as any)._parseTimeout) {
      clearTimeout((managed as any)._parseTimeout);
    }

    (managed as any)._parseTimeout = setTimeout(() => {
      if (managed.buffer.trim()) {
        const stripped = stripAnsi(managed.buffer);
        if (stripped.trim()) {
          const msg: ChatMessage = {
            id: uuidv4(),
            role: 'copilot',
            content: stripped.trim(),
            timestamp: new Date().toISOString(),
          };
          managed.messages.push(msg);
          this.emit('message', managed.session.id, msg);
        }
        managed.buffer = '';
      }
    }, 500);
  }
}

function stripAnsi(str: string): string {
  return str.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
            .replace(/\x1B\][^\x07]*\x07/g, '')
            .replace(/\x1B[()][AB012]/g, '')
            .replace(/\x1B[\x40-\x5F]/g, '');
}

export const sessionManager = new SessionManager();
