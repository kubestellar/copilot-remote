/**
 * Tests for PromptDetector — ANSI stripping, prompt pattern matching,
 * debounce, watch/unwatch lifecycle.
 *
 * We test the raw PTY fallback path (no tmux) since tmux isn't available
 * in the test environment.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PromptDetector } from '../prompt-detector.js';

describe('PromptDetector', () => {
  let detector: PromptDetector;

  beforeEach(() => {
    vi.useFakeTimers();
    detector = new PromptDetector();
  });

  afterEach(() => {
    detector.cleanup('test');
    vi.useRealTimers();
  });

  // ── Core lifecycle ────────────────────────────────────────────────────

  it('should not emit prompt when not watching', () => {
    const handler = vi.fn();
    detector.on('prompt', handler);
    detector.feed('test', '$ ');
    vi.advanceTimersByTime(600);
    expect(handler).not.toHaveBeenCalled();
  });

  it('should emit prompt after idle timeout when watching', () => {
    const handler = vi.fn();
    detector.on('prompt', handler);
    detector.watchForPrompt('test');
    detector.feed('test', 'user@host:~$ ');
    vi.advanceTimersByTime(600);
    expect(handler).toHaveBeenCalledWith('test');
  });

  it('should debounce — reset timer on new data', () => {
    const handler = vi.fn();
    detector.on('prompt', handler);
    detector.watchForPrompt('test');
    detector.feed('test', 'compiling...\n');
    vi.advanceTimersByTime(300); // not yet idle
    detector.feed('test', 'done\nuser@host:~$ ');
    vi.advanceTimersByTime(300); // still not idle from second feed
    expect(handler).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300); // now idle
    expect(handler).toHaveBeenCalledOnce();
  });

  it('should auto-unwatch after detecting prompt', () => {
    const handler = vi.fn();
    detector.on('prompt', handler);
    detector.watchForPrompt('test');
    detector.feed('test', '$ ');
    vi.advanceTimersByTime(600);
    expect(handler).toHaveBeenCalledOnce();

    // Feed more data — should NOT emit again (unwatched)
    detector.feed('test', '$ ');
    vi.advanceTimersByTime(600);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('should handle unwatchPrompt during pending timer', () => {
    const handler = vi.fn();
    detector.on('prompt', handler);
    detector.watchForPrompt('test');
    detector.feed('test', '$ ');
    detector.unwatchPrompt('test'); // cancel before idle fires
    vi.advanceTimersByTime(600);
    expect(handler).not.toHaveBeenCalled();
  });

  it('should cleanup all state for a terminal', () => {
    const handler = vi.fn();
    detector.on('prompt', handler);
    detector.watchForPrompt('test');
    detector.setTmuxSession('test', 'session-1');
    detector.feed('test', '$ ');
    detector.cleanup('test');
    vi.advanceTimersByTime(600);
    expect(handler).not.toHaveBeenCalled();
  });

  // ── Prompt pattern matching ───────────────────────────────────────────

  const promptCases = [
    ['bash $ prompt', 'user@host:~/dir$ '],
    ['root # prompt', '[root@server ~]# '],
    ['bare $ prompt', '$ '],
    ['csh % prompt', '% '],
    ['generic > prompt', '> '],
    ['starship ❯ prompt', '~/projects ❯ '],
    ['oh-my-zsh ➜ prompt', 'project git:(main) ➜ '],
    ['lambda λ prompt', 'λ '],
    ['Claude CLI ❯ prompt', '❯  Type @ to mention files'],
    ['Claude CLI > prompt', '>  Type @ to mention files'],
  ];

  for (const [name, prompt] of promptCases) {
    it(`should detect ${name}`, () => {
      const handler = vi.fn();
      detector.on('prompt', handler);
      detector.watchForPrompt('test');
      detector.feed('test', prompt as string);
      vi.advanceTimersByTime(600);
      expect(handler).toHaveBeenCalledWith('test');
    });
  }

  // ── ANSI stripping ────────────────────────────────────────────────────

  it('should strip ANSI escape sequences before matching', () => {
    const handler = vi.fn();
    detector.on('prompt', handler);
    detector.watchForPrompt('test');
    // Prompt with color codes: \x1b[32muser@host\x1b[0m:\x1b[34m~/dir\x1b[0m$
    detector.feed('test', '\x1b[32muser@host\x1b[0m:\x1b[34m~/dir\x1b[0m$ ');
    vi.advanceTimersByTime(600);
    expect(handler).toHaveBeenCalledWith('test');
  });

  it('should strip OSC sequences before matching', () => {
    const handler = vi.fn();
    detector.on('prompt', handler);
    detector.watchForPrompt('test');
    // OSC title: \x1b]0;user@host:~/dir\x07  followed by prompt
    detector.feed('test', '\x1b]0;user@host:~/dir\x07$ ');
    vi.advanceTimersByTime(600);
    expect(handler).toHaveBeenCalledWith('test');
  });

  // ── Non-prompt output should NOT trigger ──────────────────────────────

  it('should not trigger on regular command output', () => {
    const handler = vi.fn();
    detector.on('prompt', handler);
    detector.watchForPrompt('test');
    detector.feed('test', 'total 32\ndrwxr-xr-x  4 user user 128 Mar  3 08:00 .\n');
    vi.advanceTimersByTime(600);
    expect(handler).not.toHaveBeenCalled();
  });

  it('should not trigger on empty output', () => {
    const handler = vi.fn();
    detector.on('prompt', handler);
    detector.watchForPrompt('test');
    detector.feed('test', '');
    vi.advanceTimersByTime(600);
    expect(handler).not.toHaveBeenCalled();
  });

  // ── Multi-line output with prompt at end ──────────────────────────────

  it('should detect prompt after multi-line output', () => {
    const handler = vi.fn();
    detector.on('prompt', handler);
    detector.watchForPrompt('test');
    detector.feed('test', 'Building...\nDone in 2.3s\nuser@host:~$ ');
    vi.advanceTimersByTime(600);
    expect(handler).toHaveBeenCalledWith('test');
  });

  // ── Multiple terminals ────────────────────────────────────────────────

  it('should track multiple terminals independently', () => {
    const handler = vi.fn();
    detector.on('prompt', handler);
    detector.watchForPrompt('t1');
    detector.watchForPrompt('t2');

    detector.feed('t1', '$ ');
    vi.advanceTimersByTime(600);
    expect(handler).toHaveBeenCalledWith('t1');
    expect(handler).toHaveBeenCalledTimes(1);

    detector.feed('t2', '# ');
    vi.advanceTimersByTime(600);
    expect(handler).toHaveBeenCalledWith('t2');
    expect(handler).toHaveBeenCalledTimes(2);
  });
});
