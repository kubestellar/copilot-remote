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

/** Detect available AI CLI tools */
function detectAiClis(): { name: string; path: string }[] {
  const clis: { name: string; path: string }[] = [];
  for (const name of ['copilot', 'claude']) {
    try {
      const p = execSync(`which ${name}`, { encoding: 'utf8' }).trim();
      if (p) clis.push({ name, path: p });
    } catch { /* not installed */ }
  }
  return clis;
}

const AI_CLIS = detectAiClis();

class TerminalManager extends EventEmitter {
  private terminals = new Map<string, Terminal>();

  create(id: string, cwd?: string, aiCli?: string): Terminal {
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
        ';', 'set', '-g', 'window-size', 'largest',
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

    // Auto-launch AI CLI after shell is ready
    if (aiCli) {
      const cli = AI_CLIS.find(c => c.name === aiCli);
      if (cli) {
        setTimeout(() => term.write(`${cli.name}\r`), 500);
      }
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

  /** Attach to an existing tmux session by name */
  attach(id: string, tmuxSession: string): Terminal {
    if (this.terminals.has(id)) return this.terminals.get(id)!;
    if (!TMUX_PATH) throw new Error('tmux is not installed');

    // Use new-session -t to create a grouped session that shares windows
    // This avoids blank screen from nested attach and allows independent resize
    // Must unset TMUX env to avoid "sessions should be nested with care" error
    const groupName = `cr-${id.replace('term-', '')}`;
    const envNoTmux = { ...process.env, TERM: 'xterm-256color' } as Record<string, string>;
    delete envNoTmux.TMUX;
    const term = pty.spawn(TMUX_PATH, [
      'new-session', '-s', groupName, '-t', tmuxSession,
      ';', 'set', '-g', 'mouse', 'on',
      ';', 'set', '-g', 'window-size', 'largest',
      ';', 'set', '-g', 'aggressive-resize', 'on',
    ], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: homedir(),
      env: envNoTmux,
    });

    const terminal: Terminal = {
      id,
      pty: term,
      cwd: homedir(),
      createdAt: new Date().toISOString(),
      tmuxSession,
      lastCommand: '',
      inputBuffer: '',
    };

    term.onData((data) => this.emit('data', id, data));
    term.onExit(({ exitCode }) => {
      this.emit('exit', id, exitCode);
      this.terminals.delete(id);
    });

    this.terminals.set(id, terminal);
    return terminal;
  }

  /** List tmux sessions available on the machine */
  listTmuxSessions(): string[] {
    if (!TMUX_PATH) return [];
    try {
      const out = execSync(`${TMUX_PATH} list-sessions -F "#{session_name}"`, { encoding: 'utf8' });
      return out.trim().split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }

  write(id: string, data: string): boolean {
    const t = this.terminals.get(id);
    if (!t) return false;
    t.pty.write(data);

    // Track commands: accumulate input, capture on Enter
    // Skip if data contains escape sequences (mouse events, arrow keys, etc.)
    if (data.includes('\x1b')) return true;

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
    // Also force tmux to resize its window to match
    if (TMUX_PATH && t.tmuxSession) {
      try {
        execSync(`${TMUX_PATH} resize-window -t ${t.tmuxSession} -x ${cols} -y ${rows}`, { stdio: 'ignore' });
      } catch { /* session may not exist or resize not needed */ }
    }
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

  listAiClis() {
    return AI_CLIS;
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
