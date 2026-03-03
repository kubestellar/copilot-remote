/**
 * Tests for the terminal wheel-event scroll handler.
 *
 * The handler intercepts ALL wheel events on .xterm elements to prevent macOS
 * trackpad momentum "rocket scroll". It throttles aggressively (200ms) then
 * re-dispatches a minimal synthetic event (deltaY ±3) so xterm.js can send
 * mouse-wheel escape sequences to tmux naturally.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Handler constants (must match TerminalView.tsx) ─────────────────────
const THROTTLE_MS = 200;

/**
 * Standalone version of the scroll handler logic extracted from TerminalView.
 * Attaches to `document` in capture phase, just like the real code.
 */
function installScrollHandler() {
  let lastWheel = 0;

  const handler = (e: WheelEvent) => {
    if ((e as any).__smoothScroll) return;

    const target = e.target as HTMLElement;
    if (!target?.closest?.('.xterm')) return;

    e.preventDefault();
    e.stopImmediatePropagation();

    const now = performance.now();
    if (now - lastWheel < THROTTLE_MS) return;
    lastWheel = now;

    const synth = new WheelEvent('wheel', {
      deltaX: 0,
      deltaY: e.deltaY > 0 ? 3 : -3,
      deltaMode: 0,
      bubbles: true,
      cancelable: true,
      clientX: e.clientX,
      clientY: e.clientY,
    });
    Object.defineProperty(synth, '__smoothScroll', { value: true });
    target.dispatchEvent(synth);
  };

  document.addEventListener('wheel', handler, { capture: true });
  return () => document.removeEventListener('wheel', handler, { capture: true });
}

// ── Helpers ─────────────────────────────────────────────────────────────
function createXtermElement(): HTMLDivElement {
  const xterm = document.createElement('div');
  xterm.classList.add('xterm');
  const inner = document.createElement('div');
  inner.classList.add('xterm-screen');
  xterm.appendChild(inner);
  document.body.appendChild(xterm);
  return inner;
}

function fireWheel(target: HTMLElement, deltaY: number) {
  const ev = new WheelEvent('wheel', {
    deltaY,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(ev);
  return ev;
}

// ── Tests ───────────────────────────────────────────────────────────────
describe('Terminal scroll handler', () => {
  let cleanup: () => void;
  let target: HTMLDivElement;

  beforeEach(() => {
    target = createXtermElement();
    cleanup = installScrollHandler();
  });

  afterEach(() => {
    cleanup();
    target.parentElement?.remove();
  });

  it('should re-dispatch a synthetic event with __smoothScroll flag', () => {
    const received: WheelEvent[] = [];
    target.addEventListener('wheel', (e) => received.push(e));

    fireWheel(target, 100);

    expect(received.length).toBe(1);
    expect((received[0] as any).__smoothScroll).toBe(true);
  });

  it('should normalize deltaY to ±3 regardless of input magnitude', () => {
    const received: WheelEvent[] = [];
    target.addEventListener('wheel', (e) => received.push(e));

    fireWheel(target, 5000); // extreme momentum value
    expect(received[0].deltaY).toBe(3);
  });

  it('should preserve scroll direction: positive deltaY stays positive', () => {
    const received: WheelEvent[] = [];
    target.addEventListener('wheel', (e) => received.push(e));

    fireWheel(target, 100);
    expect(received[0].deltaY).toBe(3); // positive preserved
  });

  it('should preserve scroll direction: negative deltaY stays negative', () => {
    const received: WheelEvent[] = [];
    target.addEventListener('wheel', (e) => received.push(e));

    fireWheel(target, -300);
    expect(received[0].deltaY).toBe(-3); // negative preserved
  });

  it('should throttle at 200ms — blocks rapid momentum events', async () => {
    const received: WheelEvent[] = [];
    target.addEventListener('wheel', (e) => received.push(e));

    fireWheel(target, 50);
    fireWheel(target, 50);
    fireWheel(target, 50);

    // Only the first should pass throttle
    expect(received.length).toBe(1);

    // Wait past throttle window then fire again
    await new Promise((r) => setTimeout(r, THROTTLE_MS + 10));
    fireWheel(target, 50);
    expect(received.length).toBe(2);
  });

  it('should not intercept wheel events outside .xterm', () => {
    const outside = document.createElement('div');
    document.body.appendChild(outside);

    const prevented: boolean[] = [];
    outside.addEventListener('wheel', (e) => prevented.push(e.defaultPrevented));

    const ev = new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true });
    outside.dispatchEvent(ev);

    expect(prevented.length).toBe(1);
    expect(prevented[0]).toBe(false);
    outside.remove();
  });

  it('should let __smoothScroll events pass through untouched', () => {
    const received: WheelEvent[] = [];
    target.parentElement!.addEventListener('wheel', (e) => received.push(e));

    const synth = new WheelEvent('wheel', {
      deltaY: 42,
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(synth, '__smoothScroll', { value: true });
    target.dispatchEvent(synth);

    expect(received.length).toBe(1);
    expect(received[0].deltaY).toBe(42); // untouched
  });

  it('should block original event from reaching parent (stopImmediatePropagation)', () => {
    const parentReceived: WheelEvent[] = [];
    // Listen in bubble phase on parent
    target.parentElement!.addEventListener('wheel', (e) => {
      if (!(e as any).__smoothScroll) parentReceived.push(e);
    });

    fireWheel(target, 100);

    // Parent should only see the synthetic, not the original
    expect(parentReceived.length).toBe(0);
  });
});
