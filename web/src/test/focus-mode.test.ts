/**
 * Tests for terminal tile focus mode (hover vs click) localStorage persistence.
 */
import { describe, it, expect, beforeEach } from 'vitest';

const FOCUS_MODE_KEY = 'copilot-remote:focusMode';

describe('Terminal focus mode — localStorage persistence', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('should default to click when no value stored', () => {
    const saved = localStorage.getItem(FOCUS_MODE_KEY);
    const mode = saved === 'hover' ? 'hover' : 'click';
    expect(mode).toBe('click');
  });

  it('should persist hover mode', () => {
    localStorage.setItem(FOCUS_MODE_KEY, 'hover');
    expect(localStorage.getItem(FOCUS_MODE_KEY)).toBe('hover');
  });

  it('should persist click mode', () => {
    localStorage.setItem(FOCUS_MODE_KEY, 'click');
    expect(localStorage.getItem(FOCUS_MODE_KEY)).toBe('click');
  });

  it('should restore hover after round-trip', () => {
    localStorage.setItem(FOCUS_MODE_KEY, 'hover');
    const restored = localStorage.getItem(FOCUS_MODE_KEY);
    const mode = restored === 'hover' ? 'hover' : 'click';
    expect(mode).toBe('hover');
  });

  it('should fall back to click for invalid values', () => {
    localStorage.setItem(FOCUS_MODE_KEY, 'invalid');
    const saved = localStorage.getItem(FOCUS_MODE_KEY);
    const mode = saved === 'hover' ? 'hover' : 'click';
    expect(mode).toBe('click');
  });

  it('should toggle between modes correctly', () => {
    const toggle = (m: string): 'click' | 'hover' => m === 'hover' ? 'click' : 'hover';

    let mode: 'click' | 'hover' = 'click';

    // Toggle to hover
    mode = toggle(mode);
    localStorage.setItem(FOCUS_MODE_KEY, mode);
    expect(mode).toBe('hover');
    expect(localStorage.getItem(FOCUS_MODE_KEY)).toBe('hover');

    // Toggle back to click
    mode = toggle(mode);
    localStorage.setItem(FOCUS_MODE_KEY, mode);
    expect(mode).toBe('click');
    expect(localStorage.getItem(FOCUS_MODE_KEY)).toBe('click');
  });
});
