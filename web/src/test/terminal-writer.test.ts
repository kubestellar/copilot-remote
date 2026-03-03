/**
 * Tests for TerminalWriter — RAF batching, DEC 2026 sync output, and backpressure.
 *
 * These tests verify the core rocket-scroll prevention: data arriving from
 * PTY is batched per animation frame, DEC 2026 synchronized output blocks
 * are flushed atomically, and backpressure pauses the data source when
 * xterm.js falls behind.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Polyfill rAF / cAF for jsdom (not provided by default) ─────────────
const rafCallbacks: Array<{ id: number; cb: FrameRequestCallback }> = [];
let rafCounter = 0;

globalThis.requestAnimationFrame = (cb: FrameRequestCallback): number => {
  const id = ++rafCounter;
  rafCallbacks.push({ id, cb });
  return id;
};

globalThis.cancelAnimationFrame = (id: number): void => {
  const idx = rafCallbacks.findIndex(r => r.id === id);
  if (idx !== -1) rafCallbacks.splice(idx, 1);
};

/** Run all pending rAF callbacks (simulates one frame) */
function flushRAF() {
  const pending = rafCallbacks.splice(0);
  pending.forEach(({ cb }) => cb(performance.now()));
}

// ── Mock Terminal ───────────────────────────────────────────────────────
class MockTerminal {
  written: Array<{ data: string; hasCallback: boolean }> = [];
  private callbacks: Array<() => void> = [];

  write(data: string, callback?: () => void) {
    this.written.push({ data, hasCallback: !!callback });
    if (callback) this.callbacks.push(callback);
  }

  /** Simulate xterm.js processing the written data */
  processAll() {
    const cbs = this.callbacks.splice(0);
    cbs.forEach(cb => cb());
  }

  lastWritten(): string {
    return this.written[this.written.length - 1]?.data ?? '';
  }
}

// ── Standalone TerminalWriter (mirrors TerminalView.tsx implementation) ──
class TerminalWriter {
  private queue = '';
  private rafId: number | null = null;
  private syncMode = false;
  private syncBuffer = '';
  private watermark = 0;
  private paused = false;
  private _onPause: (() => void) | null = null;
  private _onResume: (() => void) | null = null;

  private static readonly HIGH_WATER = 128_000;
  private static readonly LOW_WATER = 16_000;
  private static readonly SYNC_START = '\x1b[?2026h';
  private static readonly SYNC_END = '\x1b[?2026l';

  constructor(private term: MockTerminal) {}

  setFlowCallbacks(onPause: () => void, onResume: () => void) {
    this._onPause = onPause;
    this._onResume = onResume;
  }

  write(data: string) {
    const startIdx = data.indexOf(TerminalWriter.SYNC_START);
    const endIdx = data.indexOf(TerminalWriter.SYNC_END);

    if (startIdx !== -1 && !this.syncMode) {
      if (startIdx > 0) this.enqueue(data.slice(0, startIdx));
      this.syncMode = true;
      const remainder = data.slice(startIdx + TerminalWriter.SYNC_START.length);
      if (remainder) this.write(remainder);
      return;
    }

    if (this.syncMode) {
      if (endIdx !== -1) {
        this.syncBuffer += data.slice(0, endIdx);
        this.syncMode = false;
        this.enqueue(this.syncBuffer);
        this.syncBuffer = '';
        const after = data.slice(endIdx + TerminalWriter.SYNC_END.length);
        if (after) this.write(after);
      } else {
        this.syncBuffer += data;
      }
      return;
    }

    this.enqueue(data);
  }

  private enqueue(data: string) {
    this.queue += data;
    this.scheduleFlush();
  }

  private scheduleFlush() {
    if (this.rafId === null) {
      this.rafId = requestAnimationFrame(() => this.flush());
    }
  }

  private flush() {
    this.rafId = null;
    if (!this.queue) return;

    const data = this.queue;
    this.queue = '';
    this.watermark += data.length;

    if (!this.paused && this.watermark > TerminalWriter.HIGH_WATER) {
      this.paused = true;
      this._onPause?.();
    }

    this.term.write(data, () => {
      this.watermark = Math.max(0, this.watermark - data.length);
      if (this.paused && this.watermark < TerminalWriter.LOW_WATER) {
        this.paused = false;
        this._onResume?.();
      }
    });

    if (this.queue) this.scheduleFlush();
  }

  dispose() {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    if (this.syncBuffer) { this.queue += this.syncBuffer; this.syncBuffer = ''; }
    if (this.queue) { this.term.write(this.queue); this.queue = ''; }
  }

  // Test accessors
  get isPaused() { return this.paused; }
  get isSyncMode() { return this.syncMode; }
}

// ── Tests ────────────────────────────────────────────────────────────────
describe('TerminalWriter', () => {
  let term: MockTerminal;
  let writer: TerminalWriter;

  beforeEach(() => {
    term = new MockTerminal();
    writer = new TerminalWriter(term);
  });

  afterEach(() => {
    writer.dispose();
  });

  // ── RAF Batching ───────────────────────────────────────────────────────

  it('should batch multiple writes into one RAF flush', () => {
    writer.write('hello');
    writer.write(' world');
    writer.write('!');

    // Before RAF fires, nothing written to terminal
    expect(term.written.length).toBe(0);

    flushRAF();

    // All data combined into one write
    expect(term.written.length).toBe(1);
    expect(term.written[0].data).toBe('hello world!');
  });

  it('should write with callback for backpressure tracking', () => {
    writer.write('test');
    flushRAF();

    expect(term.written[0].hasCallback).toBe(true);
  });

  it('should handle multiple frames independently', () => {
    writer.write('frame1');
    flushRAF();

    writer.write('frame2');
    flushRAF();

    expect(term.written.length).toBe(2);
    expect(term.written[0].data).toBe('frame1');
    expect(term.written[1].data).toBe('frame2');
  });

  // ── DEC 2026 Synchronized Output ──────────────────────────────────────

  it('should buffer data during sync mode (DEC 2026)', () => {
    writer.write('\x1b[?2026h');  // begin sync
    writer.write('buffered line 1\n');
    writer.write('buffered line 2\n');

    flushRAF();

    // Nothing written yet — still in sync mode
    expect(term.written.length).toBe(0);
    expect(writer.isSyncMode).toBe(true);
  });

  it('should flush atomically when sync ends', () => {
    writer.write('\x1b[?2026h');
    writer.write('line1\n');
    writer.write('line2\n');
    writer.write('\x1b[?2026l');  // end sync

    flushRAF();

    expect(term.written.length).toBe(1);
    expect(term.written[0].data).toBe('line1\nline2\n');
    expect(writer.isSyncMode).toBe(false);
  });

  it('should handle sync start and end in same chunk', () => {
    writer.write('\x1b[?2026hatomic content\x1b[?2026l');
    flushRAF();

    expect(term.written.length).toBe(1);
    expect(term.written[0].data).toBe('atomic content');
  });

  it('should handle data before sync start', () => {
    writer.write('before\x1b[?2026hsynced\x1b[?2026lafter');
    flushRAF();

    // "before" is enqueued first, then "synced", then "after" — but all in same RAF
    expect(term.written.length).toBe(1);
    expect(term.written[0].data).toBe('beforesyncedafter');
  });

  it('should handle multiple sync blocks', () => {
    writer.write('\x1b[?2026hblock1\x1b[?2026l');
    flushRAF();
    expect(term.written[0].data).toBe('block1');

    writer.write('\x1b[?2026hblock2\x1b[?2026l');
    flushRAF();
    expect(term.written[1].data).toBe('block2');
  });

  // ── Backpressure ──────────────────────────────────────────────────────

  it('should trigger pause when watermark exceeds HIGH', () => {
    const onPause = vi.fn();
    const onResume = vi.fn();
    writer.setFlowCallbacks(onPause, onResume);

    // Write more than HIGH_WATER (128KB)
    const largeData = 'x'.repeat(130_000);
    writer.write(largeData);
    flushRAF();

    expect(onPause).toHaveBeenCalledOnce();
    expect(writer.isPaused).toBe(true);
  });

  it('should trigger resume when watermark drops below LOW', () => {
    const onPause = vi.fn();
    const onResume = vi.fn();
    writer.setFlowCallbacks(onPause, onResume);

    const largeData = 'x'.repeat(130_000);
    writer.write(largeData);
    flushRAF();

    expect(writer.isPaused).toBe(true);

    // Simulate xterm.js processing the data
    term.processAll();

    expect(onResume).toHaveBeenCalledOnce();
    expect(writer.isPaused).toBe(false);
  });

  it('should not trigger pause for small writes', () => {
    const onPause = vi.fn();
    writer.setFlowCallbacks(onPause, () => {});

    writer.write('small data');
    flushRAF();

    expect(onPause).not.toHaveBeenCalled();
    expect(writer.isPaused).toBe(false);
  });

  // ── Dispose ───────────────────────────────────────────────────────────

  it('should flush remaining data on dispose', () => {
    writer.write('pending');
    // Don't await RAF — call dispose directly
    writer.dispose();

    expect(term.written.length).toBe(1);
    expect(term.written[0].data).toBe('pending');
  });

  it('should flush sync buffer on dispose', () => {
    writer.write('\x1b[?2026h');
    writer.write('synced but not ended');
    writer.dispose();

    expect(term.written.length).toBe(1);
    expect(term.written[0].data).toBe('synced but not ended');
  });
});
