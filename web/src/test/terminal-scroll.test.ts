/**
 * Tests for the terminal wheel-event scroll handler.
 *
 * The handler intercepts ALL wheel events on .xterm elements to prevent macOS
 * trackpad momentum "rocket scroll". Instead of re-dispatching, it calls
 * term.scrollLines() with a fixed small step count.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Handler constants (must match TerminalView.tsx) ─────────────────────
const THROTTLE_MS = 100;
const SCROLL_LINES = 3;

/**
 * Mock terminal instances map — mirrors the module-level termInstances in
 * TerminalView.tsx. The handler iterates this to find the terminal whose
 * container owns the event target.
 */
const termInstances = new Map<string, {
  term: { scrollLines: ReturnType<typeof vi.fn> };
  container: HTMLDivElement | null;
}>();

/**
 * Standalone version of the scroll handler logic extracted from TerminalView.
 * Uses the local termInstances map above.
 */
function installScrollHandler() {
  let lastWheel = 0;

  const handler = (e: WheelEvent) => {
    const target = e.target as HTMLElement;
    if (!target?.closest?.('.xterm')) return;

    e.preventDefault();
    e.stopImmediatePropagation();

    const now = performance.now();
    if (now - lastWheel < THROTTLE_MS) return;
    lastWheel = now;

    const direction = e.deltaY > 0 ? -SCROLL_LINES : SCROLL_LINES;
    for (const [, inst] of termInstances) {
      if (inst.container?.contains(target)) {
        inst.term.scrollLines(direction);
        break;
      }
    }
  };

  document.addEventListener('wheel', handler, { capture: true });
  return () => document.removeEventListener('wheel', handler, { capture: true });
}

// ── Helpers ─────────────────────────────────────────────────────────────
function createXtermElement(): { container: HTMLDivElement; inner: HTMLDivElement } {
  const container = document.createElement('div');
  const xterm = document.createElement('div');
  xterm.classList.add('xterm');
  const inner = document.createElement('div');
  inner.classList.add('xterm-screen');
  xterm.appendChild(inner);
  container.appendChild(xterm);
  document.body.appendChild(container);
  return { container, inner };
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
  let container: HTMLDivElement;
  let target: HTMLDivElement;
  let mockTerm: { scrollLines: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    const el = createXtermElement();
    container = el.container;
    target = el.inner;
    mockTerm = { scrollLines: vi.fn() };
    termInstances.set('test-tab', { term: mockTerm, container });
    cleanup = installScrollHandler();
  });

  afterEach(() => {
    cleanup();
    termInstances.clear();
    container.remove();
  });

  it('should call scrollLines with negative direction for scroll down (natural scrolling)', () => {
    fireWheel(target, 100);
    expect(mockTerm.scrollLines).toHaveBeenCalledWith(-SCROLL_LINES);
  });

  it('should call scrollLines with positive direction for scroll up (natural scrolling)', () => {
    fireWheel(target, -100);
    expect(mockTerm.scrollLines).toHaveBeenCalledWith(SCROLL_LINES);
  });

  it('should use fixed step size regardless of deltaY magnitude', () => {
    fireWheel(target, 5000); // extreme momentum
    expect(mockTerm.scrollLines).toHaveBeenCalledWith(-SCROLL_LINES);
  });

  it('should throttle rapid scroll events', async () => {
    fireWheel(target, 50);
    fireWheel(target, 50);
    fireWheel(target, 50);

    // Only the first should pass throttle
    expect(mockTerm.scrollLines).toHaveBeenCalledTimes(1);

    // Wait past throttle window then fire again
    await new Promise((r) => setTimeout(r, THROTTLE_MS + 10));
    fireWheel(target, 50);
    expect(mockTerm.scrollLines).toHaveBeenCalledTimes(2);
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

  it('should block original event (preventDefault + stopImmediatePropagation)', () => {
    const parentReceived: WheelEvent[] = [];
    container.addEventListener('wheel', (e) => parentReceived.push(e));

    fireWheel(target, 100);

    // Parent should NOT receive the event (stopImmediatePropagation in capture)
    expect(parentReceived.length).toBe(0);
  });

  it('should match terminal by container.contains(target)', () => {
    const mockTerm2 = { scrollLines: vi.fn() };
    const el2 = createXtermElement();
    termInstances.set('tab-2', { term: mockTerm2, container: el2.container });

    // Scroll in terminal 2's element
    fireWheel(el2.inner, 100);
    expect(mockTerm2.scrollLines).toHaveBeenCalledWith(-SCROLL_LINES);
    expect(mockTerm.scrollLines).not.toHaveBeenCalled();

    el2.container.remove();
  });
});
