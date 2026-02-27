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

  constructor() {
    super();
    // Set tmux global defaults so all sessions (including ones created by copilot CLI) use largest
    if (TMUX_PATH) {
      try {
        execSync(`${TMUX_PATH} set-option -g window-size largest`, { stdio: 'ignore' });
        execSync(`${TMUX_PATH} set-option -g aggressive-resize on`, { stdio: 'ignore' });
      } catch {}
    }
  }

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

    const terminal: Terminal = {
      id,
      pty: term,
      cwd: resolvedCwd,
      createdAt: new Date().toISOString(),
      tmuxSession: TMUX_PATH ? tmuxName : '',
      lastCommand: aiCli || '',
      inputBuffer: '',
    };

    // Auto-launch AI CLI after shell is ready
    if (aiCli) {
      const cli = AI_CLIS.find(c => c.name === aiCli);
      if (cli) {
        setTimeout(() => term.write(`${cli.name}\r`), 500);
      }
    }

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
    // Set window-size on the TARGET session too (overrides any session-level setting like 'manual')
    try {
      execSync(`${TMUX_PATH} set-option -t "${tmuxSession}" window-size largest`, { stdio: 'ignore' });
    } catch {}
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

  /** Re-adopt orphaned cr-* tmux sessions from a previous server run */
  reAdoptOrphanedSessions(): number {
    if (!TMUX_PATH) return 0;

    // Force window-size largest on ALL existing tmux sessions
    try {
      const allSessions = execSync(`${TMUX_PATH} list-sessions -F "#{session_name}"`, { encoding: 'utf8' })
        .trim().split('\n').filter(Boolean);
      for (const s of allSessions) {
        try { execSync(`${TMUX_PATH} set-option -t "${s}" window-size largest`, { stdio: 'ignore' }); } catch {}
      }
    } catch {}

    // Get session names and their groups
    let sessionInfo: { name: string; group: string }[] = [];
    try {
      const out = execSync(`${TMUX_PATH} list-sessions -F "#{session_name}\t#{session_group}"`, { encoding: 'utf8' });
      sessionInfo = out.trim().split('\n').filter(Boolean).map(line => {
        const [name, group] = line.split('\t');
        return { name, group: group || '' };
      });
    } catch { return 0; }

    let adopted = 0;
    for (const { name: s, group } of sessionInfo) {
      if (!s.startsWith('cr-')) continue;
      // Skip if already managed
      if (Array.from(this.terminals.values()).some(t => t.tmuxSession === s)) continue;
      // Kill stale grouped clone sessions (session_name !== session_group means it's a clone)
      // If session_name === session_group, it's the original session that owns the group — keep it
      if (group && s !== group) {
        try {
          execSync(`${TMUX_PATH} kill-session -t "${s}"`, { stdio: 'ignore' });
          console.log(`[Terminal] Killed stale grouped clone: ${s} (group: ${group})`);
        } catch {}
        continue;
      }
      const id = `term-${s.replace('cr-', '')}`;
      try {
        // Set window-size on the target session (overrides session-level 'manual' etc.)
        try {
          execSync(`${TMUX_PATH} set-option -t "${s}" window-size largest`, { stdio: 'ignore' });
        } catch {}
        // Use grouped session (new-session -t) for independent resize per client
        const groupName = `cr-${Date.now()}`;
        const envNoTmux = { ...process.env, TERM: 'xterm-256color' } as Record<string, string>;
        delete envNoTmux.TMUX;
        const term = pty.spawn(TMUX_PATH, [
          'new-session', '-s', groupName, '-t', s,
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
          tmuxSession: s,
          lastCommand: s,  // Use session name so client doesn't treat as stale
          inputBuffer: '',
        };

        term.onData((data) => this.emit('data', id, data));
        term.onExit(({ exitCode }) => {
          this.emit('exit', id, exitCode);
          this.terminals.delete(id);
        });

        this.terminals.set(id, terminal);
        adopted++;
        console.log(`[Terminal] Re-adopted orphaned tmux session: ${s}`);
      } catch (err: any) {
        console.error(`[Terminal] Failed to re-adopt ${s}: ${err.message}`);
      }
    }
    return adopted;
  }
}

export const terminalManager = new TerminalManager();
