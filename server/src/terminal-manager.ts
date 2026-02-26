import { EventEmitter } from 'events';
import * as pty from 'node-pty';
import { homedir } from 'os';

interface Terminal {
  id: string;
  pty: pty.IPty;
  cwd: string;
  createdAt: string;
}

class TerminalManager extends EventEmitter {
  private terminals = new Map<string, Terminal>();

  create(id: string, cwd?: string): Terminal {
    if (this.terminals.has(id)) {
      return this.terminals.get(id)!;
    }

    const shell = process.env.SHELL || '/bin/zsh';
    const resolvedCwd = cwd || homedir();

    let term: pty.IPty;
    try {
      term = pty.spawn(shell, [], {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: resolvedCwd,
        env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
      });
    } catch {
      // Fallback: try /bin/bash, then /bin/sh
      try {
        term = pty.spawn('/bin/bash', [], {
          name: 'xterm-256color',
          cols: 80,
          rows: 24,
          cwd: resolvedCwd,
          env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
        });
      } catch {
        term = pty.spawn('/bin/sh', [], {
          name: 'xterm-256color',
          cols: 80,
          rows: 24,
          cwd: resolvedCwd,
          env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
        });
      }
    }

    const terminal: Terminal = {
      id,
      pty: term,
      cwd: resolvedCwd,
      createdAt: new Date().toISOString(),
    };

    term.onData((data) => {
      this.emit('data', id, data);
    });

    term.onExit(({ exitCode }) => {
      this.emit('exit', id, exitCode);
      this.terminals.delete(id);
    });

    this.terminals.set(id, terminal);
    return terminal;
  }

  write(id: string, data: string): boolean {
    const t = this.terminals.get(id);
    if (!t) return false;
    t.pty.write(data);
    return true;
  }

  resize(id: string, cols: number, rows: number): boolean {
    const t = this.terminals.get(id);
    if (!t) return false;
    t.pty.resize(cols, rows);
    return true;
  }

  destroy(id: string): boolean {
    const t = this.terminals.get(id);
    if (!t) return false;
    t.pty.kill();
    this.terminals.delete(id);
    return true;
  }

  get(id: string) {
    return this.terminals.get(id);
  }

  list() {
    return Array.from(this.terminals.values()).map(t => ({
      id: t.id,
      cwd: t.cwd,
      createdAt: t.createdAt,
    }));
  }
}

export const terminalManager = new TerminalManager();
