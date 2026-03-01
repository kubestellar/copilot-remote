import { EventEmitter } from 'events';
import { execSync } from 'child_process';

/** Time (ms) to wait after last PTY output before checking the pane for a prompt */
const PROMPT_IDLE_TIMEOUT_MS = 500;

/** Regex to strip ANSI escape sequences from terminal output */
const PROMPT_ANSI_STRIP_REGEX = /\x1b\[[0-9;]*[a-zA-Z]/g;

/** Additional regex to strip OSC sequences (\x1b]...\x07 or \x1b]...\x1b\\) */
const OSC_STRIP_REGEX = /\x1b\].*?(?:\x07|\x1b\\)/g;

/** Common shell prompt-ending patterns */
/** Number of lines from the bottom of the pane to scan for prompt patterns */
const PROMPT_SCAN_LINES = 10;

/** Common shell prompt-ending patterns (checked against each line) */
const PROMPT_PATTERNS = [
  /[$#%>]\s*$/,     // generic endings (bash $, root #, csh %, claude >)
  /\]\$\s*$/,       // bash: user@host:~/dir]$
  /\]#\s*$/,        // root: user@host:~/dir]#
  /❯\s*$/,          // starship / modern prompts (❯ at end)
  /➜\s*$/,          // oh-my-zsh robbyrussell
  /λ\s*$/,          // lambda prompts
  /^\s*>\s*$/,      // bare > prompt (Claude CLI empty input)
  /^\s*❯\s/,        // Claude CLI prompt: ❯  Type @ to mention...
  /^\s*>\s+Type\s/,  // Claude CLI prompt: >  Type @ to mention...
];

/** Path to tmux binary (resolved once at module load) */
const TMUX_PATH = (() => {
  try { return execSync('which tmux', { encoding: 'utf8' }).trim(); } catch { return null; }
})();

/**
 * Detects when a shell prompt appears after PTY output settles.
 *
 * Uses `tmux capture-pane` to read actual pane content (excluding the
 * status bar) when a tmux session is available.  Falls back to tracking
 * raw PTY output for non-tmux terminals.
 */
export class PromptDetector extends EventEmitter {
  /** Set of terminal IDs actively being watched */
  private watching = new Set<string>();

  /** Debounce timers per terminal */
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Last line of raw PTY output per terminal (fallback for non-tmux) */
  private lastLines = new Map<string, string>();

  /** Map of terminal ID → tmux session name */
  private tmuxSessions = new Map<string, string>();

  /** Register the tmux session name for a terminal (call once at create) */
  setTmuxSession(id: string, sessionName: string): void {
    if (sessionName) this.tmuxSessions.set(id, sessionName);
  }

  /** Start watching a terminal for prompt return */
  watchForPrompt(id: string): void {
    this.watching.add(id);
    this.lastLines.set(id, '');
  }

  /** Stop watching a terminal */
  unwatchPrompt(id: string): void {
    this.watching.delete(id);
    this.lastLines.delete(id);
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
  }

  /** Feed PTY output data for a terminal */
  feed(id: string, data: string): void {
    if (!this.watching.has(id)) return;

    // Update last line from raw PTY output (used as fallback for non-tmux)
    const stripped = data.replace(PROMPT_ANSI_STRIP_REGEX, '').replace(OSC_STRIP_REGEX, '');
    const lines = stripped.split(/\r?\n/);
    const lastSegment = lines[lines.length - 1];

    if (lines.length > 1) {
      this.lastLines.set(id, lastSegment);
    } else {
      const current = this.lastLines.get(id) || '';
      this.lastLines.set(id, current + lastSegment);
    }

    // Reset debounce timer — check after output settles
    const existingTimer = this.timers.get(id);
    if (existingTimer) clearTimeout(existingTimer);

    this.timers.set(id, setTimeout(() => {
      this.timers.delete(id);
      this.checkForPrompt(id);
    }, PROMPT_IDLE_TIMEOUT_MS));
  }

  /** Check if the terminal is showing a prompt */
  private checkForPrompt(id: string): void {
    if (!this.watching.has(id)) return;

    const tmuxSession = this.tmuxSessions.get(id);
    if (tmuxSession && TMUX_PATH) {
      // Use tmux capture-pane to get actual pane content (no status bar)
      this.checkViaTmux(id, tmuxSession);
    } else {
      // Fallback: check raw PTY last line
      this.checkViaLastLine(id);
    }
  }

  /** Check prompt via tmux capture-pane (reliable — excludes status bar) */
  private checkViaTmux(id: string, sessionName: string): void {
    try {
      const paneContent = execSync(
        `${TMUX_PATH} capture-pane -t "${sessionName}" -p`,
        { encoding: 'utf8', timeout: 2000 },
      );

      // Scan the last N non-empty lines for prompt patterns.
      // TUI apps (Claude CLI, etc.) render prompt indicators on lines
      // that may not be the very last line of the pane.
      const paneLines = paneContent.split('\n');
      const candidates: string[] = [];
      for (let i = paneLines.length - 1; i >= 0 && candidates.length < PROMPT_SCAN_LINES; i--) {
        const trimmed = paneLines[i].trim();
        if (trimmed) candidates.push(trimmed);
      }

      const isPrompt = candidates.some(line =>
        PROMPT_PATTERNS.some(pattern => pattern.test(line))
      );
      if (isPrompt) {
        this.unwatchPrompt(id);
        this.emit('prompt', id);
      }
    } catch {
      // tmux command failed — fall back to raw PTY check
      this.checkViaLastLine(id);
    }
  }

  /** Check prompt via raw PTY output last line (fallback) */
  private checkViaLastLine(id: string): void {
    const lastLine = (this.lastLines.get(id) || '').trim();
    if (!lastLine) return;

    const isPrompt = PROMPT_PATTERNS.some(pattern => pattern.test(lastLine));
    if (isPrompt) {
      this.unwatchPrompt(id);
      this.emit('prompt', id);
    }
  }

  /** Clean up all state for a terminal (e.g., on disconnect) */
  cleanup(id: string): void {
    this.unwatchPrompt(id);
    this.tmuxSessions.delete(id);
  }
}
