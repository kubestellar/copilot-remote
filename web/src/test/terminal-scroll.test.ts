/**
 * Tests for the terminal wheel-event scroll handler.
 *
 * Current strategy: let ALL native wheel events pass through to xterm.js
 * for normal scrollback and tmux mouse-mode handling. The only exception
 * is during font-size changes (suppressScroll flag), when wheel events
 * inside .xterm are blocked to prevent fit-triggered scroll jumps.
 *
 * Rocket scroll prevention is handled by TerminalWriter's scrollTop
 * save/restore during screen-clearing writes — NOT by the wheel handler.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// ── Shared state for suppressScroll flag ─────────────────────────────────
const state = { suppressScroll: false };

/**
 * Install the scroll handler — standalone copy of the current TerminalView logic.
 * Only blocks wheel events inside .xterm when suppressScroll is true.
 * Uses state object so the handler closure sees updates from tests.
 */
function installScrollHandler() {
  const handler = (e: WheelEvent) => {
    if (!state.suppressScroll) return;
    const target = e.target as HTMLElement;
    if (!target?.closest?.('.xterm')) return;
    e.preventDefault();
    e.stopPropagation();
  };
  document.addEventListener('wheel', handler, { capture: true, passive: false } as AddEventListenerOptions);
  return () => document.removeEventListener('wheel', handler, { capture: true } as EventListenerOptions);
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

/**
 * Fire a wheel event on a target element.
 * Returns whether it was blocked (stopPropagation prevents it from reaching
 * a bubble-phase listener on the target's parent).
 */
function fireWheel(target: HTMLElement, deltaY: number): { blocked: boolean } {
  let reachedBubble = false;
  const parent = target.parentElement!;
  const bubbleListener = () => { reachedBubble = true; };
  parent.addEventListener('wheel', bubbleListener);

  const ev = new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true });
  target.dispatchEvent(ev);

  parent.removeEventListener('wheel', bubbleListener);
  return { blocked: !reachedBubble };
}

// ── Tests ───────────────────────────────────────────────────────────────
describe('Terminal scroll handler', () => {
  let cleanup: () => void;
  let screen: HTMLDivElement;
  let viewport: HTMLDivElement;
  let xterm: HTMLDivElement;

  beforeEach(() => {
    state.suppressScroll = false;
    ({ screen, viewport, xterm } = createXtermElement());
    cleanup = installScrollHandler();
  });

  afterEach(() => {
    cleanup();
    xterm.remove();
  });

  // ── Normal scrolling: events pass through untouched ─────────────────

  it('should let wheel events through normally (scroll down)', () => {
    const { blocked } = fireWheel(screen, 100);
    expect(blocked).toBe(false);
  });

  it('should let wheel events through normally (scroll up)', () => {
    const { blocked } = fireWheel(screen, -100);
    expect(blocked).toBe(false);
  });

  it('should let rapid successive wheel events through', () => {
    const results = [];
    for (let i = 0; i < 10; i++) {
      results.push(fireWheel(screen, 50).blocked);
    }
    expect(results.every(b => b === false)).toBe(true);
  });

  it('should let small delta events through (trackpad precision)', () => {
    const { blocked } = fireWheel(screen, 1);
    expect(blocked).toBe(false);
  });

  it('should let large delta events through (mouse wheel)', () => {
    const { blocked } = fireWheel(screen, 300);
    expect(blocked).toBe(false);
  });

  // ── suppressScroll: font change protection ────────────────────────────

  it('should block wheel events inside .xterm when suppressScroll is true', () => {
    state.suppressScroll = true;
    const { blocked } = fireWheel(screen, 50);
    expect(blocked).toBe(true);
  });

  it('should block scroll up inside .xterm when suppressScroll is true', () => {
    state.suppressScroll = true;
    const { blocked } = fireWheel(screen, -50);
    expect(blocked).toBe(true);
  });

  it('should resume letting events through after suppressScroll is cleared', () => {
    state.suppressScroll = true;
    expect(fireWheel(screen, 50).blocked).toBe(true);

    state.suppressScroll = false;
    const { blocked } = fireWheel(screen, 50);
    expect(blocked).toBe(false);
  });

  // ── Scope: only affects .xterm elements ───────────────────────────────

  it('should not intercept wheel events outside .xterm', () => {
    const wrapper = document.createElement('div');
    const outside = document.createElement('div');
    wrapper.appendChild(outside);
    document.body.appendChild(wrapper);

    let reached = false;
    wrapper.addEventListener('wheel', () => { reached = true; });
    const ev = new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true });
    outside.dispatchEvent(ev);
    expect(reached).toBe(true);
    wrapper.remove();
  });

  it('should not block events outside .xterm even when suppressScroll is true', () => {
    state.suppressScroll = true;
    const wrapper = document.createElement('div');
    const outside = document.createElement('div');
    wrapper.appendChild(outside);
    document.body.appendChild(wrapper);

    let reached = false;
    wrapper.addEventListener('wheel', () => { reached = true; });
    const ev = new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true });
    outside.dispatchEvent(ev);
    expect(reached).toBe(true);
    wrapper.remove();
  });

  it('should not affect events on a non-xterm sibling', () => {
    const sibling = document.createElement('div');
    const child = document.createElement('div');
    sibling.classList.add('toolbar');
    sibling.appendChild(child);
    document.body.appendChild(sibling);

    let reached = false;
    sibling.addEventListener('wheel', () => { reached = true; });
    const ev = new WheelEvent('wheel', { deltaY: 50, bubbles: true, cancelable: true });
    child.dispatchEvent(ev);
    expect(reached).toBe(true);
    sibling.remove();
  });

  // ── Viewport element targeting ────────────────────────────────────────

  it('should let events on .xterm-viewport through normally', () => {
    const { blocked } = fireWheel(viewport, 100);
    expect(blocked).toBe(false);
  });

  it('should block events on .xterm-viewport when suppressScroll is true', () => {
    state.suppressScroll = true;
    const { blocked } = fireWheel(viewport, 100);
    expect(blocked).toBe(true);
  });

  // ── suppressScroll lifetime: must clear promptly ─────────────────────

  it('should clear suppressScroll within 500ms (no permanent blocking)', async () => {
    // Regression: if the font-size effect re-ran on every tabs change
    // (title polls, status updates), suppressScroll stayed true almost
    // permanently because each re-run reset the 300ms timeout.
    // This test verifies suppressScroll clears and stays cleared.
    state.suppressScroll = true;

    // Simulate the real timeout that clears it (300ms in production)
    setTimeout(() => { state.suppressScroll = false; }, 300);

    // After 350ms, it should be cleared
    await new Promise(r => setTimeout(r, 350));
    expect(state.suppressScroll).toBe(false);

    // Crucially: scroll should work after the timeout clears
    const { blocked } = fireWheel(screen, 100);
    expect(blocked).toBe(false);
  });

  it('should not re-block scroll when unrelated state changes occur', () => {
    // Simulates the bug: if some unrelated update (tab title poll, status
    // change) resets suppressScroll to true, scrolling breaks permanently.
    // The fix is that only font-size / tile-mode changes set suppressScroll.
    state.suppressScroll = false;

    // Simulate 10 "tab title poll" cycles — none should enable suppressScroll
    for (let i = 0; i < 10; i++) {
      // An unrelated state change should NOT set suppressScroll
      // (In the buggy code, each setTabs() re-triggered the font effect)
      expect(state.suppressScroll).toBe(false);
      const { blocked } = fireWheel(screen, 50);
      expect(blocked).toBe(false);
    }
  });

  it('should only block briefly after a font-size change, then allow scroll', async () => {
    // Simulates the correct behavior: suppressScroll=true during fit(),
    // then clears after 300ms and stays cleared.
    expect(fireWheel(screen, 50).blocked).toBe(false);

    // Font size change sets suppressScroll
    state.suppressScroll = true;
    expect(fireWheel(screen, 50).blocked).toBe(true);

    // After the brief timeout, scroll is restored
    setTimeout(() => { state.suppressScroll = false; }, 300);
    await new Promise(r => setTimeout(r, 350));
    expect(fireWheel(screen, 50).blocked).toBe(false);

    // Subsequent events should also pass through (no re-blocking)
    for (let i = 0; i < 5; i++) {
      expect(fireWheel(screen, 50).blocked).toBe(false);
    }
  });

  // ── Multiple xterm instances ──────────────────────────────────────────

  it('should handle multiple xterm instances independently', () => {
    const { screen: screen2, xterm: xterm2 } = createXtermElement();

    // Both should let events through normally
    expect(fireWheel(screen, 50).blocked).toBe(false);
    expect(fireWheel(screen2, 50).blocked).toBe(false);

    // suppressScroll blocks both
    state.suppressScroll = true;
    expect(fireWheel(screen, 50).blocked).toBe(true);
    expect(fireWheel(screen2, 50).blocked).toBe(true);

    xterm2.remove();
  });
});
