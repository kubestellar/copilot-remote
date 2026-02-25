import { EventEmitter } from 'events';
import { spawn, ChildProcess } from 'child_process';
import { Writable, Readable } from 'stream';
import * as acp from '@agentclientprotocol/sdk';
import type { Session } from './types.js';

interface AcpSession {
  sessionId: string;       // copilot session ID
  acpSessionId?: string;   // ACP protocol session ID
  proc: ChildProcess;
  connection: acp.ClientSideConnection;
  status: 'connecting' | 'ready' | 'prompting' | 'dead';
}

/**
 * Manages ACP (Agent Client Protocol) connections to Copilot CLI.
 * Each session gets a persistent copilot --acp process for streaming, multi-turn conversations.
 * 
 * Events:
 *   'chunk' (sessionId, text) — streaming text chunk
 *   'tool' (sessionId, { title, status }) — tool call status
 *   'turn_complete' (sessionId, stopReason) — prompt turn finished
 *   'error' (sessionId, error) — connection error
 */
class AcpManager extends EventEmitter {
  private sessions = new Map<string, AcpSession>();

  hasSession(id: string): boolean {
    const s = this.sessions.get(id);
    return !!s && s.status !== 'dead';
  }

  async getOrCreate(sessionId: string): Promise<AcpSession> {
    const existing = this.sessions.get(sessionId);
    if (existing && existing.status !== 'dead') {
      return existing;
    }

    return this.createAcpSession(sessionId);
  }

  private async createAcpSession(sessionId: string): Promise<AcpSession> {
    const copilotPath = process.env.COPILOT_PATH || 'copilot';

    const proc = spawn(copilotPath, ['--acp', '--allow-all'], {
      cwd: process.env.HOME || '/',
      env: process.env,
      stdio: ['pipe', 'pipe', 'inherit'],
    });

    const acpSession: AcpSession = {
      sessionId,
      proc,
      connection: null as any,
      status: 'connecting',
    };

    this.sessions.set(sessionId, acpSession);

    const self = this;

    // Client handler receives streaming updates from copilot
    const client: acp.Client = {
      async requestPermission(params: any) {
        // Auto-approve all (--allow-all should handle this, but just in case)
        const allowOption = params.options?.find((o: any) => o.kind === 'allow_always' || o.kind === 'allow_once');
        return {
          outcome: {
            outcome: 'selected',
            optionId: allowOption?.optionId || params.options?.[0]?.optionId || '',
          },
        };
      },

      async sessionUpdate(params: any) {
        const update = params.update;
        switch (update.sessionUpdate) {
          case 'agent_message_chunk':
            if (update.content?.type === 'text' && update.content.text) {
              self.emit('chunk', sessionId, update.content.text);
            }
            break;
          case 'tool_call':
            self.emit('tool', sessionId, { title: update.title, status: update.status });
            break;
          case 'tool_call_update':
            self.emit('tool', sessionId, { toolCallId: update.toolCallId, status: update.status });
            break;
          default:
            break;
        }
      },

      async readTextFile(params: any) {
        // Let copilot handle file reading through its own tools
        return { content: '' };
      },

      async writeTextFile(params: any) {
        return {};
      },
    };

    try {
      const input = Writable.toWeb(proc.stdin!) as WritableStream<Uint8Array>;
      const output = Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>;
      const stream = acp.ndJsonStream(input, output);

      const connection = new acp.ClientSideConnection((_agent: any) => client, stream);
      acpSession.connection = connection;

      // Initialize the ACP connection
      const initResult = await connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
        },
      });

      console.log(`[ACP] Connected to copilot (protocol v${initResult.protocolVersion}) for session ${sessionId.slice(0, 8)}`);

      // Resume the existing session
      const cwd = process.env.HOME || '/';
      try {
        const resumeResult = await (connection as any).unstable_resumeSession({
          sessionId,
        });
        acpSession.acpSessionId = sessionId;
        console.log(`[ACP] Resumed session ${sessionId.slice(0, 8)}`);
      } catch {
        // If resume not supported, try loadSession
        try {
          const loadResult = await connection.loadSession({
            sessionId,
            cwd,
            mcpServers: [],
          });
          acpSession.acpSessionId = sessionId;
          console.log(`[ACP] Loaded session ${sessionId.slice(0, 8)}`);
        } catch {
          // Fall back to new session
          const newResult = await connection.newSession({
            cwd,
            mcpServers: [],
          });
          acpSession.acpSessionId = newResult.sessionId;
          console.log(`[ACP] New session ${(newResult.sessionId || '').slice(0, 8)} (could not resume/load)`);
        }
      }

      acpSession.status = 'ready';

      // Handle process death
      proc.on('exit', (code) => {
        console.log(`[ACP] Process exited (code ${code}) for session ${sessionId.slice(0, 8)}`);
        acpSession.status = 'dead';
        this.emit('error', sessionId, new Error(`ACP process exited with code ${code}`));
      });

      proc.on('error', (err) => {
        console.error(`[ACP] Process error for session ${sessionId.slice(0, 8)}:`, err.message);
        acpSession.status = 'dead';
        this.emit('error', sessionId, err);
      });

      // Handle connection close
      connection.signal.addEventListener('abort', () => {
        acpSession.status = 'dead';
      });

      return acpSession;

    } catch (err: any) {
      console.error(`[ACP] Failed to connect for session ${sessionId.slice(0, 8)}:`, err.message);
      acpSession.status = 'dead';
      try { proc.kill(); } catch {}
      throw err;
    }
  }

  /**
   * Send a prompt and receive streaming chunks via events.
   * Returns the prompt result when the turn completes.
   */
  async sendPrompt(sessionId: string, text: string): Promise<{ stopReason: string }> {
    const session = await this.getOrCreate(sessionId);

    if (session.status !== 'ready') {
      throw new Error(`ACP session ${sessionId.slice(0, 8)} is ${session.status}, not ready`);
    }

    session.status = 'prompting';
    this.emit('prompt_start', sessionId, text);

    try {
      const result = await session.connection.prompt({
        sessionId: session.acpSessionId || sessionId,
        prompt: [{ type: 'text', text }],
      });

      session.status = 'ready';
      this.emit('turn_complete', sessionId, result.stopReason);
      return { stopReason: result.stopReason };

    } catch (err: any) {
      session.status = session.proc?.exitCode === null ? 'ready' : 'dead';
      this.emit('error', sessionId, err);
      throw err;
    }
  }

  /**
   * Kill an ACP session's process.
   */
  destroy(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (session?.proc) {
      try { session.proc.kill(); } catch {}
    }
    session && (session.status = 'dead');
    this.sessions.delete(sessionId);
  }

  destroyAll() {
    for (const [id] of this.sessions) {
      this.destroy(id);
    }
  }
}

export const acpManager = new AcpManager();
