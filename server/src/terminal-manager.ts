import { EventEmitter } from 'events';
import * as pty from 'node-pty';
import { homedir } from 'os';
import { execSync } from 'child_process';

interface Terminal {
  id: string;
  pty: pty.IPty;
  cwd: string;
  createdAt: string;
  tmuxSession: string;
  lastCommand: string;
  inputBuffer: string;
}

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
    const tmuxName = `cr-${id.replace('term-', '')}`;

    let term: pty.IPty;
    if (TMUX_PATH) {
      // Spawn inside tmux with mouse, aggressive-resize, window-size latest
      term = pty.spawn(TMUX_PATH, [
        'new-session', '-s', tmuxName, '-x', '80', '-y', '24',
        ';', 'set', '-g', 'mouse', 'on',
        ';', 'set', '-g', 'window-size', 'latest',
        ';', 'set', '-g', 'aggressive-resize', 'on',
      ], {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: resolvedCwd,
        env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
      });
    } else {
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
      lastCommand: '',
      inputBuffer: '',
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

    // Track commands: accumulate input, capture on Enter
    for (const ch of data) {
      if (ch === '\r' || ch === '\n') {
        const cmd = t.inputBuffer.trim();
        if (cmd) {
          t.lastCommand = cmd;
          this.emit('command', id, cmd);
        }
        t.inputBuffer = '';
      } else if (ch === '\x7f' || ch === '\b') {
        t.inputBuffer = t.inputBuffer.slice(0, -1);
      } else if (ch.charCodeAt(0) >= 32) {
        t.inputBuffer += ch;
      }
    }
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
      lastCommand: t.lastCommand,
    }));
  }
}

export const terminalManager = new TerminalManager();
