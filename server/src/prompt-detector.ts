import { EventEmitter } from 'events';

/** Time (ms) to wait after last PTY output before testing for a shell prompt */
const PROMPT_IDLE_TIMEOUT_MS = 300;

/** Regex to strip ANSI escape sequences from terminal output */
const PROMPT_ANSI_STRIP_REGEX = /\x1b\[[0-9;]*[a-zA-Z]/g;

/** Common shell prompt-ending patterns */
const PROMPT_PATTERNS = [
  /[$#%>]\s*$/,     // generic endings
  /\]\$\s*$/,       // bash: user@host:~/dir]$
  /\]#\s*$/,        // root: user@host:~/dir]#
  /❯\s*$/,          // starship / modern prompts
  /➜\s*$/,          // oh-my-zsh robbyrussell
  /λ\s*$/,          // lambda prompts
];

/**
 * Detects when a shell prompt appears after PTY output settles.
 *
 * For each watched terminal, accumulates the last line of output.
 * When output stops for PROMPT_IDLE_TIMEOUT_MS, tests the last line
 * against common prompt patterns and emits 'prompt' if matched.
 */
export class PromptDetector extends EventEmitter {
  /** Set of terminal IDs actively being watched */
  private watching = new Set<string>();

  /** Debounce timers per terminal */
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Last line of output per terminal (for prompt matching) */
  private lastLines = new Map<string, string>();

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

    // Update last line: split by newlines, keep last non-empty segment
    const stripped = data.replace(PROMPT_ANSI_STRIP_REGEX, '');
    const lines = stripped.split(/\r?\n/);
    const lastSegment = lines[lines.length - 1];

    // If data contains newlines, the last line is a fresh start
    if (lines.length > 1) {
      this.lastLines.set(id, lastSegment);
    } else {
      // Append to current last line
      const current = this.lastLines.get(id) || '';
      this.lastLines.set(id, current + lastSegment);
    }

    // Reset debounce timer
    const existingTimer = this.timers.get(id);
    if (existingTimer) clearTimeout(existingTimer);

    this.timers.set(id, setTimeout(() => {
      this.timers.delete(id);
      this.checkForPrompt(id);
    }, PROMPT_IDLE_TIMEOUT_MS));
  }

  /** Check if the last line matches a prompt pattern */
  private checkForPrompt(id: string): void {
    if (!this.watching.has(id)) return;

    const lastLine = (this.lastLines.get(id) || '').trim();
    if (!lastLine) return;

    const isPrompt = PROMPT_PATTERNS.some(pattern => pattern.test(lastLine));
    if (isPrompt) {
      // Stop watching — prompt detected, item is done
      this.unwatchPrompt(id);
      this.emit('prompt', id);
    }
  }

  /** Clean up all state for a terminal (e.g., on disconnect) */
  cleanup(id: string): void {
    this.unwatchPrompt(id);
  }
}
