/**
 * Tests for the terminal wheel-event scroll handler.
 *
 * Strategy v7: Block ALL native wheel events, detect momentum scrolling,
 * re-dispatch controlled synthetic events with clamped deltaY on the
 * .xterm-viewport element. A module-level flag prevents the capture handler
 * from re-catching synthetic events. Momentum detection identifies macOS
 * trackpad inertial scrolling by tracking delta decay patterns.
 *
 * The handler listens on `document` in capture phase so it intercepts events
 * before xterm.js sees them.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Constants matching TerminalView.tsx ──────────────────────────────────
const THROTTLE_MS = 120;
const MOMENTUM_THRESHOLD = 3;
const MOMENTUM_RESET_MS = 300;

// ── Simulated suppressScroll flag (mirrors module-level in TerminalView) ─
let suppressScroll = false;

/**
 * Install the scroll handler — standalone copy of the TerminalView v7 logic.
 */
function installScrollHandler() {
  let lastWheel = 0;
  let lastAbsDelta = 0;
  let momentumCount = 0;
  let isSynthetic = false;

  const handler = (e: WheelEvent) => {
    // Let our own synthetic events pass through untouched
    if (isSynthetic) return;

    const target = e.target as HTMLElement;
    const xtermEl = target?.closest?.('.xterm');
    if (!xtermEl) return;

    // Block ALL native wheel events
    e.preventDefault();
    e.stopImmediatePropagation();

    // During font changes, block all scroll entirely
    if (suppressScroll) return;

    const now = performance.now();
    const elapsed = now - lastWheel;
    const absDelta = Math.abs(e.deltaY);

    // Momentum detection
    if (elapsed < 80 && absDelta > 0) {
      if (absDelta <= lastAbsDelta || absDelta < 4) {
        momentumCount++;
      } else {
        momentumCount = 0;
      }
    } else if (elapsed >= MOMENTUM_RESET_MS) {
      momentumCount = 0;
    }

    lastAbsDelta = absDelta;

    // If we've detected momentum scrolling, block completely
    if (momentumCount >= MOMENTUM_THRESHOLD) {
      lastWheel = now;
      return;
    }

    // Throttle
    if (elapsed < THROTTLE_MS) return;

    lastWheel = now;

    // Find the viewport element inside xterm for dispatching
    const viewport = xtermEl.querySelector('.xterm-viewport');
    if (!viewport) return;

    // Re-dispatch with clamped deltaY
    const clampedDelta = Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY), 3);
    const syntheticEvent = new WheelEvent('wheel', {
      deltaX: 0,
      deltaY: clampedDelta,
      deltaMode: e.deltaMode,
      bubbles: true,
      cancelable: true,
      clientX: e.clientX,
      clientY: e.clientY,
    });

    isSynthetic = true;
    viewport.dispatchEvent(syntheticEvent);
    isSynthetic = false;
  };

  document.addEventListener('wheel', handler, { capture: true });
  return () => document.removeEventListener('wheel', handler, { capture: true });
}

// ── Helpers ─────────────────────────────────────────────────────────────

/** Create a .xterm > .xterm-viewport > .xterm-screen DOM structure */
function createXtermElement(): { screen: HTMLDivElement; viewport: HTMLDivElement; xterm: HTMLDivElement } {
  const xterm = document.createElement('div');
  xterm.classList.add('xterm');
  const viewport = document.createElement('div');
  viewport.classList.add('xterm-viewport');
  const screen = document.createElement('div');
  screen.classList.add('xterm-screen');
  xterm.appendChild(viewport);
  xterm.appendChild(screen);
  document.body.appendChild(xterm);
  return { screen, viewport, xterm };
}

/** Fire a native wheel event on the screen element, return whether a synthetic event reached the viewport */
function fireWheel(screen: HTMLElement, viewport: HTMLElement, deltaY: number): { reachedViewport: boolean; syntheticDeltaY: number | null } {
  let reachedViewport = false;
  let syntheticDeltaY: number | null = null;
  const viewportListener = (e: WheelEvent) => { reachedViewport = true; syntheticDeltaY = e.deltaY; };
  viewport.addEventListener('wheel', viewportListener as EventListener);

  const ev = new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true });
  screen.dispatchEvent(ev);

  viewport.removeEventListener('wheel', viewportListener as EventListener);
  return { reachedViewport, syntheticDeltaY };
}

// ── Tests ───────────────────────────────────────────────────────────────
describe('Terminal scroll handler v7', () => {
  let cleanup: () => void;
  let screen: HTMLDivElement;
  let viewport: HTMLDivElement;
  let xterm: HTMLDivElement;

  beforeEach(() => {
    suppressScroll = false;
    ({ screen, viewport, xterm } = createXtermElement());
    cleanup = installScrollHandler();
  });

  afterEach(() => {
    cleanup();
    xterm.remove();
  });

  // ── Core: first event dispatches synthetic with clamped delta ─────────

  it('should dispatch a synthetic event on first wheel', () => {
    const { reachedViewport } = fireWheel(screen, viewport, 100);
    expect(reachedViewport).toBe(true);
  });

  it('should clamp deltaY to max ±3 on synthetic events', () => {
    const { syntheticDeltaY } = fireWheel(screen, viewport, 250);
    expect(syntheticDeltaY).toBe(3);
  });

  it('should clamp negative deltaY to -3', () => {
    const { syntheticDeltaY } = fireWheel(screen, viewport, -250);
    expect(syntheticDeltaY).toBe(-3);
  });

  it('should preserve small deltaY values (below clamp)', () => {
    const { syntheticDeltaY } = fireWheel(screen, viewport, 2);
    expect(syntheticDeltaY).toBe(2);
  });

  // ── Throttle: rapid events are blocked ────────────────────────────────

  it('should block the second rapid event', () => {
    fireWheel(screen, viewport, 50); // first — dispatches synthetic
    const { reachedViewport } = fireWheel(screen, viewport, 50); // second — blocked
    expect(reachedViewport).toBe(false);
  });

  it('should block many rapid events — only first dispatches', () => {
    const results = [];
    for (let i = 0; i < 10; i++) {
      results.push(fireWheel(screen, viewport, 100).reachedViewport);
    }
    expect(results[0]).toBe(true);
    expect(results.slice(1).every(r => r === false)).toBe(true);
  });

  it('should allow events again after throttle window expires', async () => {
    const r1 = fireWheel(screen, viewport, 50);
    expect(r1.reachedViewport).toBe(true);

    await new Promise((r) => setTimeout(r, THROTTLE_MS + 20));

    const r2 = fireWheel(screen, viewport, 50);
    expect(r2.reachedViewport).toBe(true);
  });

  // ── Momentum detection ────────────────────────────────────────────────

  it('should detect and block momentum scrolling (decaying deltas)', async () => {
    // First intentional scroll
    const first = fireWheel(screen, viewport, 100);
    expect(first.reachedViewport).toBe(true);

    // In jsdom, dispatchEvent is synchronous so elapsed = 0ms between calls.
    // This means elapsed < 80 (rapid) — so momentum counter increments on decaying deltas.
    // After MOMENTUM_THRESHOLD (3) consecutive decaying rapid events, further events are blocked.
    // Events 2-4 are throttled (elapsed < THROTTLE_MS), but they still increment momentum counter.
    fireWheel(screen, viewport, 50);  // rapid, decay from 100 → momentum++
    fireWheel(screen, viewport, 40);  // rapid, decay from 50 → momentum++
    fireWheel(screen, viewport, 30);  // rapid, decay from 40 → momentum++ (now >= MOMENTUM_THRESHOLD)

    // Wait past throttle to allow another event through
    await new Promise((r) => setTimeout(r, THROTTLE_MS + 10));

    // Even though throttle window has elapsed, momentum detection should block this
    // because elapsed < MOMENTUM_RESET_MS (300ms) and momentum count >= threshold
    const r = fireWheel(screen, viewport, 20);
    expect(r.reachedViewport).toBe(false);
  });

  it('should reset momentum detection after a long pause', async () => {
    fireWheel(screen, viewport, 100);

    // Wait longer than MOMENTUM_RESET_MS
    await new Promise((r) => setTimeout(r, MOMENTUM_RESET_MS + 50));

    const r = fireWheel(screen, viewport, 50);
    expect(r.reachedViewport).toBe(true);
  });

  // ── Scope: only affects .xterm elements ───────────────────────────────

  it('should not intercept wheel events outside .xterm', () => {
    const outside = document.createElement('div');
    document.body.appendChild(outside);

    let reached = false;
    outside.addEventListener('wheel', () => { reached = true; });
    const ev = new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true });
    outside.dispatchEvent(ev);
    expect(reached).toBe(true);
    outside.remove();
  });

  it('should not affect events on a non-xterm sibling', () => {
    const sibling = document.createElement('div');
    sibling.classList.add('toolbar');
    document.body.appendChild(sibling);

    fireWheel(screen, viewport, 50);
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
    const { reachedViewport } = fireWheel(screen, viewport, 50);
    expect(reachedViewport).toBe(false);
  });

  it('should resume after suppressScroll is cleared', () => {
    suppressScroll = true;
    fireWheel(screen, viewport, 50); // blocked

    suppressScroll = false;
    const { reachedViewport } = fireWheel(screen, viewport, 50);
    expect(reachedViewport).toBe(true);
  });

  // ── Direction: synthetic events maintain correct scroll direction ──────

  it('should pass positive deltaY (scroll down) with correct sign', () => {
    const { syntheticDeltaY } = fireWheel(screen, viewport, 300);
    expect(syntheticDeltaY).toBeGreaterThan(0);
  });

  it('should pass negative deltaY (scroll up) with correct sign', () => {
    const { syntheticDeltaY } = fireWheel(screen, viewport, -300);
    expect(syntheticDeltaY).toBeLessThan(0);
  });
});
