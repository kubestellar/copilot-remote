import { EventEmitter } from 'events';
import * as pty from 'node-pty';
import { homedir } from 'os';
import { execSync } from 'child_process';

interface Terminal {
  id: string;
  pty: pty.IPty;
  cwd: string;
  createdAt: string;
  tmuxSession: string; // tmux session name for `tmux attach -t <name>`
}

// Check if tmux is available
const TMUX_PATH = (() => {
  try { return execSync('which tmux', { encoding: 'utf8' }).trim(); } catch { return null; }
})();

class TerminalManager extends EventEmitter {
  private terminals = new Map<string, Terminal>();

  create(id: string, cwd?: string): Terminal {
    if (this.terminals.has(id)) {
      return this.terminals.get(id)!;
    }

    const resolvedCwd = cwd || homedir();
    // Use a short, readable tmux session name
    const tmuxName = `cr-${id.replace('term-', '')}`;

    let term: pty.IPty;
    if (TMUX_PATH) {
      // Spawn inside tmux so the user can `tmux attach -t <name>` from their laptop
      term = pty.spawn(TMUX_PATH, ['new-session', '-s', tmuxName, '-x', '80', '-y', '24'], {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: resolvedCwd,
        env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
      });
    } else {
      // Fallback: bare shell (no sharing)
      const shell = process.env.SHELL || '/bin/zsh';
      term = pty.spawn(shell, [], {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: resolvedCwd,
        env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
      });
    }

    const terminal: Terminal = {
      id,
      pty: term,
      cwd: resolvedCwd,
      createdAt: new Date().toISOString(),
      tmuxSession: TMUX_PATH ? tmuxName : '',
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
      tmuxSession: t.tmuxSession,
    }));
  }
}

export const terminalManager = new TerminalManager();
