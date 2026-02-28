import { EventEmitter } from 'events';
import * as pty from 'node-pty';
import { homedir } from 'os';
import { execSync } from 'child_process';
import { PromptDetector } from './prompt-detector.js';

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
  try { return execSync('which tmux', { encoding: 'utf8' }).trim(); } catch (_err) { return null; }
})();

/** Detect available AI CLI tools */
function detectAiClis(): { name: string; path: string }[] {
  const clis: { name: string; path: string }[] = [];
  for (const name of ['copilot', 'claude']) {
    try {
      const p = execSync(`which ${name}`, { encoding: 'utf8' }).trim();
      if (p) clis.push({ name, path: p });
    } catch (_err) { /* not installed */ }
  }
  return clis;
}

const AI_CLIS = detectAiClis();

class TerminalManager extends EventEmitter {
  private terminals = new Map<string, Terminal>();
  private promptDetector = new PromptDetector();

  constructor() {
    super();
    // Forward prompt events from the detector
    this.promptDetector.on('prompt', (id: string) => {
      this.emit('prompt', id);
    });
    // Set tmux global defaults and hooks so ALL sessions use latest window-size
    // 'latest' sizes the window to the most recently active client, so
    // the web tile renders correctly when active, desktop is fine when active
    if (TMUX_PATH) {
      try {
        execSync(`${TMUX_PATH} set-option -g window-size latest`, { stdio: 'ignore' });
        execSync(`${TMUX_PATH} set-option -g aggressive-resize on`, { stdio: 'ignore' });
        execSync(`${TMUX_PATH} set-hook -g session-created 'set-option window-size latest'`, { stdio: 'ignore' });
        execSync(`${TMUX_PATH} set-hook -g client-attached 'set-option window-size latest'`, { stdio: 'ignore' });
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
      // Spawn inside tmux with mouse, aggressive-resize, window-size latest (per-session)
      term = pty.spawn(TMUX_PATH, [
        'new-session', '-s', tmuxName, '-x', '80', '-y', '24',
        ';', 'set', 'mouse', 'on',
        ';', 'set', 'window-size', 'latest',
        ';', 'set', 'aggressive-resize', 'on',
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
      this.promptDetector.feed(id, data);
    });

    term.onExit(({ exitCode }) => {
      this.emit('exit', id, exitCode);
      this.promptDetector.cleanup(id);
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
    // window-size latest: tmux sizes the window to the most recently active client
    // so the web tile gets proper rendering when active, desktop is fine when active
    const groupName = `cr-${id.replace('term-', '')}`;
    const envNoTmux = { ...process.env, TERM: 'xterm-256color' } as Record<string, string>;
    delete envNoTmux.TMUX;
    try {
      execSync(`${TMUX_PATH} set-option -t "${tmuxSession}" window-size latest`, { stdio: 'ignore' });
    } catch {}
    const term = pty.spawn(TMUX_PATH, [
      'new-session', '-s', groupName, '-t', tmuxSession,
      ';', 'set', 'mouse', 'on',
      ';', 'set', 'window-size', 'latest',
      ';', 'set', 'aggressive-resize', 'on',
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

    term.onData((data) => {
      this.emit('data', id, data);
      this.promptDetector.feed(id, data);
    });
    term.onExit(({ exitCode }) => {
      this.emit('exit', id, exitCode);
      this.promptDetector.cleanup(id);
      this.terminals.delete(id);
    });

    this.terminals.set(id, terminal);
    return terminal;
  }

  /** Start watching a terminal for shell prompt return (used by todo dispatcher) */
  watchForPrompt(id: string): void {
    this.promptDetector.watchForPrompt(id);
  }

  /** Stop watching a terminal for prompt */
  unwatchPrompt(id: string): void {
    this.promptDetector.unwatchPrompt(id);
  }

  /** List tmux sessions available on the machine */
  listTmuxSessions(): string[] {
    if (!TMUX_PATH) return [];
    try {
      const out = execSync(`${TMUX_PATH} list-sessions -F "#{session_name}"`, { encoding: 'utf8' });
      return out.trim().split('\n').filter(Boolean);
    } catch (err) {
      console.debug('[Terminal] Failed to list tmux sessions:', err);
      return [];
    }
  }

  /** Get the pane title for a tmux session (set by CLI tools via escape sequences) */
  getTmuxPaneTitle(sessionName: string): string {
    if (!TMUX_PATH) return '';
    try {
      return execSync(
        `${TMUX_PATH} display-message -t "${sessionName}" -p "#{pane_title}"`,
        { encoding: 'utf8', timeout: 2000 },
      ).trim();
    } catch {
      return '';
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
      } catch (_err) { /* session may not exist or resize not needed */ }
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

  /** Kill a tmux session by name (and destroy any managed terminal using it) */
  killTmuxSession(sessionName: string): boolean {
    if (!TMUX_PATH) return false;
    // Destroy any managed terminal that references this session
    for (const [id, t] of this.terminals) {
      if (t.tmuxSession === sessionName) {
        this.destroy(id);
      }
    }
    try {
      execSync(`${TMUX_PATH} kill-session -t "${sessionName}"`, { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
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

    // Force window-size latest on ALL existing tmux sessions
    try {
      const allSessions = execSync(`${TMUX_PATH} list-sessions -F "#{session_name}"`, { encoding: 'utf8' })
        .trim().split('\n').filter(Boolean);
      for (const s of allSessions) {
        try { execSync(`${TMUX_PATH} set-option -t "${s}" window-size latest`, { stdio: 'ignore' }); } catch {}
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
          execSync(`${TMUX_PATH} set-option -t "${s}" window-size latest`, { stdio: 'ignore' });
        } catch {}
        const groupName = `cr-${Date.now()}`;
        const envNoTmux = { ...process.env, TERM: 'xterm-256color' } as Record<string, string>;
        delete envNoTmux.TMUX;
        const term = pty.spawn(TMUX_PATH, [
          'new-session', '-s', groupName, '-t', s,
          ';', 'set', 'window-size', 'latest',
          ';', 'set', 'aggressive-resize', 'on',
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

        term.onData((data) => {
          this.emit('data', id, data);
          this.promptDetector.feed(id, data);
        });
        term.onExit(({ exitCode }) => {
          this.emit('exit', id, exitCode);
          this.promptDetector.cleanup(id);
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
