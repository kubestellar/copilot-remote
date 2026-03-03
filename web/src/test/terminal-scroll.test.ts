/**
 * Tests for the terminal wheel-event scroll handler.
 *
 * Strategy: throttle-only. Block rapid momentum events, let slow events through
 * natively to xterm.js. No synthetic re-dispatch — xterm.js handles native
 * wheel events for both its scrollback buffer and tmux mouse escape sequences.
 *
 * The handler listens on `document` in capture phase so it intercepts events
 * before xterm.js sees them.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Constants matching TerminalView.tsx ──────────────────────────────────
const THROTTLE_MS = 150;

// ── Simulated suppressScroll flag (mirrors module-level in TerminalView) ─
let suppressScroll = false;

/**
 * Install the scroll handler — standalone copy of the TerminalView logic.
 */
function installScrollHandler() {
  let lastWheel = 0;

  const handler = (e: WheelEvent) => {
    const target = e.target as HTMLElement;
    if (!target?.closest?.('.xterm')) return;

    if (suppressScroll) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }

    const now = performance.now();
    if (now - lastWheel < THROTTLE_MS) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    lastWheel = now;
    // Let event through naturally
  };

  document.addEventListener('wheel', handler, { capture: true });
  return () => document.removeEventListener('wheel', handler, { capture: true });
}

// ── Helpers ─────────────────────────────────────────────────────────────

/** Create a .xterm > .xterm-screen DOM structure and return the inner target */
function createXtermElement(): HTMLDivElement {
  const xterm = document.createElement('div');
  xterm.classList.add('xterm');
  const inner = document.createElement('div');
  inner.classList.add('xterm-screen');
  xterm.appendChild(inner);
  document.body.appendChild(xterm);
  return inner;
}

/** Fire a wheel event and check if it reaches bubble listeners (i.e. was NOT blocked) */
function fireWheel(target: HTMLElement, deltaY: number): { passedThrough: boolean; event: WheelEvent } {
  let passedThrough = false;
  const bubbleListener = () => { passedThrough = true; };
  // Listen on parent in bubble phase — only fires if handler didn't stopImmediatePropagation
  target.parentElement!.addEventListener('wheel', bubbleListener);

  const ev = new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true });
  target.dispatchEvent(ev);

  target.parentElement!.removeEventListener('wheel', bubbleListener);
  return { passedThrough, event: ev };
}

// ── Tests ───────────────────────────────────────────────────────────────
describe('Terminal scroll handler', () => {
  let cleanup: () => void;
  let target: HTMLDivElement;

  beforeEach(() => {
    suppressScroll = false;
    target = createXtermElement();
    cleanup = installScrollHandler();
  });

  afterEach(() => {
    cleanup();
    target.parentElement?.remove();
  });

  // ── Core: first event passes through ──────────────────────────────────

  it('should let the first wheel event through (not blocked)', () => {
    const { passedThrough } = fireWheel(target, 100);
    expect(passedThrough).toBe(true);
  });

  it('should preserve the original deltaY on passthrough events', () => {
    const received: WheelEvent[] = [];
    // Listen in bubble phase — if event passes through, we see it here
    target.parentElement!.addEventListener('wheel', (e) => received.push(e));

    fireWheel(target, -250);

    expect(received.length).toBe(1);
    expect(received[0].deltaY).toBe(-250);
  });

  // ── Throttle: rapid events are blocked ────────────────────────────────

  it('should block the second rapid event', () => {
    fireWheel(target, 50); // first — passes
    const { passedThrough } = fireWheel(target, 50); // second — blocked
    expect(passedThrough).toBe(false);
  });

  it('should block many rapid events — only first passes', () => {
    const results = [];
    for (let i = 0; i < 10; i++) {
      results.push(fireWheel(target, 100).passedThrough);
    }
    // First passes, rest blocked
    expect(results[0]).toBe(true);
    expect(results.slice(1).every(p => p === false)).toBe(true);
  });

  it('should allow events again after throttle window expires', async () => {
    const r1 = fireWheel(target, 50);
    expect(r1.passedThrough).toBe(true);

    // Wait past throttle
    await new Promise((r) => setTimeout(r, THROTTLE_MS + 20));

    const r2 = fireWheel(target, 50);
    expect(r2.passedThrough).toBe(true);
  });

  it('should count bubble listeners receiving events correctly', async () => {
    const received: number[] = [];
    target.parentElement!.addEventListener('wheel', (e) => received.push(e.deltaY));

    fireWheel(target, 10);   // passes
    fireWheel(target, 20);   // blocked
    fireWheel(target, 30);   // blocked

    await new Promise((r) => setTimeout(r, THROTTLE_MS + 20));
    fireWheel(target, 40);   // passes

    expect(received).toEqual([10, 40]);
  });

  // ── Scope: only affects .xterm elements ───────────────────────────────

  it('should not intercept wheel events outside .xterm', () => {
    const outside = document.createElement('div');
    document.body.appendChild(outside);

    // Need to add parent listener for fireWheel helper — use manual check
    let reached = false;
    outside.addEventListener('wheel', () => { reached = true; });
    const ev = new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true });
    outside.dispatchEvent(ev);
    expect(reached).toBe(true);
    outside.remove();
  });

  it('should not affect events on a separate non-xterm sibling', () => {
    const sibling = document.createElement('div');
    sibling.classList.add('toolbar');
    document.body.appendChild(sibling);

    // Use up the throttle on the terminal
    fireWheel(target, 50);
    // Sibling event should still pass — check with direct listener
    let reached = false;
    sibling.addEventListener('wheel', () => { reached = true; });
    const ev = new WheelEvent('wheel', { deltaY: 50, bubbles: true, cancelable: true });
    sibling.dispatchEvent(ev);
    expect(reached).toBe(true);
    sibling.remove();
  });

  // ── suppressScroll: font change protection ────────────────────────────

  it('should block ALL events when suppressScroll is true', () => {
    suppressScroll = true;
    const { passedThrough } = fireWheel(target, 50);
    expect(passedThrough).toBe(false);
  });

  it('should resume after suppressScroll is cleared', () => {
    suppressScroll = true;
    fireWheel(target, 50); // blocked

    suppressScroll = false;
    const { passedThrough } = fireWheel(target, 50);
    expect(passedThrough).toBe(true);
  });

  // ── Direction: native events maintain OS scroll direction ─────────────

  it('should pass positive deltaY through unchanged (scroll down)', () => {
    const received: number[] = [];
    target.parentElement!.addEventListener('wheel', (e) => received.push(e.deltaY));

    fireWheel(target, 300);
    expect(received).toEqual([300]);
  });

  it('should pass negative deltaY through unchanged (scroll up)', () => {
    const received: number[] = [];
    target.parentElement!.addEventListener('wheel', (e) => received.push(e.deltaY));

    fireWheel(target, -300);
    expect(received).toEqual([-300]);
  });
});
