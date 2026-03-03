/**
 * Tests for the terminal wheel-event scroll handler.
 *
 * The handler intercepts wheel events on .xterm elements, clamps deltaY to
 * prevent macOS trackpad momentum "rocket scroll", throttles the rate, then
 * re-dispatches a synthetic event so xterm.js handles scrollback AND tmux
 * mouse-sequence forwarding naturally.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Handler constants (must match TerminalView.tsx) ─────────────────────
const THROTTLE_MS = 80;
const MAX_DELTA_Y = 150;

/**
 * Standalone version of the scroll handler logic extracted from TerminalView.
 * Attaches to `document` in capture phase, just like the real code.
 */
function installScrollHandler() {
  let lastWheel = 0;

  const handler = (e: WheelEvent) => {
    if ((e as any).__clampedScroll) return;

    const target = e.target as HTMLElement;
    if (!target?.closest?.('.xterm')) return;

    e.preventDefault();
    e.stopImmediatePropagation();

    const now = performance.now();
    if (now - lastWheel < THROTTLE_MS) return;
    lastWheel = now;

    const clampedDeltaY =
      Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY), MAX_DELTA_Y);
    const synth = new WheelEvent('wheel', {
      deltaX: e.deltaX,
      deltaY: clampedDeltaY,
      deltaZ: e.deltaZ,
      deltaMode: e.deltaMode,
      bubbles: true,
      cancelable: true,
      clientX: e.clientX,
      clientY: e.clientY,
      screenX: e.screenX,
      screenY: e.screenY,
    });
    Object.defineProperty(synth, '__clampedScroll', { value: true });
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
  return inner; // wheel events target the inner element
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

  it('should dispatch a clamped synthetic event for normal scroll', () => {
    const received: WheelEvent[] = [];
    target.addEventListener('wheel', (e) => received.push(e));

    fireWheel(target, 100);

    // Should receive exactly the synthetic clamped event
    expect(received.length).toBe(1);
    expect(received[0].deltaY).toBe(100);
    expect((received[0] as any).__clampedScroll).toBe(true);
  });

  it('should clamp extreme deltaY values (momentum protection)', () => {
    const received: WheelEvent[] = [];
    target.addEventListener('wheel', (e) => received.push(e));

    fireWheel(target, 5000); // extreme momentum value

    expect(received.length).toBe(1);
    expect(received[0].deltaY).toBe(MAX_DELTA_Y); // clamped
  });

  it('should preserve negative deltaY direction (scroll up)', () => {
    const received: WheelEvent[] = [];
    target.addEventListener('wheel', (e) => received.push(e));

    fireWheel(target, -300);

    expect(received.length).toBe(1);
    expect(received[0].deltaY).toBe(-MAX_DELTA_Y); // clamped, negative preserved
  });

  it('should throttle rapid events', async () => {
    const received: WheelEvent[] = [];
    target.addEventListener('wheel', (e) => received.push(e));

    // Fire two events in quick succession
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

    // Event should pass through unmodified
    expect(prevented.length).toBe(1);
    expect(prevented[0]).toBe(false);
    outside.remove();
  });

  it('should pass through synthetic __clampedScroll events untouched', () => {
    const received: WheelEvent[] = [];
    // Listen at the xterm parent level
    target.parentElement!.addEventListener('wheel', (e) => received.push(e));

    const synth = new WheelEvent('wheel', {
      deltaY: 42,
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(synth, '__clampedScroll', { value: true });
    target.dispatchEvent(synth);

    // Should bubble up without being intercepted
    expect(received.length).toBe(1);
    expect(received[0].deltaY).toBe(42);
  });

  it('should preserve small deltaY values without clamping', () => {
    const received: WheelEvent[] = [];
    target.addEventListener('wheel', (e) => received.push(e));

    fireWheel(target, 10); // well under MAX_DELTA_Y

    expect(received.length).toBe(1);
    expect(received[0].deltaY).toBe(10); // not clamped
  });
});
