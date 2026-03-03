/**
 * Component tests for SessionList — rendering, session display,
 * and interaction callbacks.
 *
 * Uses React Testing Library with jsdom (configured in vite.config.ts).
 * The `api` module is mocked so no real HTTP requests are made.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SessionList } from '../components/SessionList';
import type { Session } from '../types';

// Mock the Primer RelativeTime component (uses the Web Component / custom element
// registry which isn't available in jsdom and would throw).
vi.mock('@primer/react', async () => {
  const actual = await vi.importActual<typeof import('@primer/react')>('@primer/react');
  return {
    ...actual,
    RelativeTime: ({ date }: { date: Date }) => <span data-testid="relative-time">{date.toISOString()}</span>,
  };
});

// Mock the api module to avoid real fetch calls
vi.mock('../lib/api', () => ({
  api: {
    updateSessionMeta: vi.fn().mockResolvedValue({}),
    addTag: vi.fn().mockResolvedValue({ tags: [] }),
    removeTag: vi.fn().mockResolvedValue({ tags: [] }),
  },
}));

const makeSession = (overrides: Partial<Session> = {}): Session => ({
  id: 'test-session-id',
  cwd: '/home/user/project',
  status: 'running',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  name: 'My Session',
  tags: [],
  ...overrides,
});

const defaultProps = {
  sessions: [] as Session[],
  loading: false,
  error: null,
  activeId: null,
  onSelect: vi.fn(),
  onDelete: vi.fn(),
  onNew: vi.fn(),
  onRefresh: vi.fn(),
};

describe('SessionList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Empty state ──────────────────────────────────────────────────────

  it('should render "No sessions found" when the sessions list is empty', () => {
    render(<SessionList {...defaultProps} />);
    expect(screen.getByText('No sessions found')).toBeTruthy();
  });

  it('should show a loading spinner when loading is true', () => {
    const { container } = render(<SessionList {...defaultProps} loading />);
    // Primer Spinner renders an SVG; just verify the "No sessions" text is gone
    expect(screen.queryByText('No sessions found')).toBeNull();
    // The container should have rendered something while loading
    expect(container.firstChild).toBeTruthy();
  });

  it('should display an error message when error is set', () => {
    render(<SessionList {...defaultProps} error="Failed to load sessions" />);
    expect(screen.getByText('Failed to load sessions')).toBeTruthy();
  });

  // ── Session rendering ────────────────────────────────────────────────

  it('should render a session by its name', () => {
    const session = makeSession({ name: 'Fix auth bug' });
    render(<SessionList {...defaultProps} sessions={[session]} />);
    expect(screen.getByText('Fix auth bug')).toBeTruthy();
  });

  it('should fall back to summary when name is absent', () => {
    const session = makeSession({ name: undefined, summary: 'Refactor storage' });
    render(<SessionList {...defaultProps} sessions={[session]} />);
    expect(screen.getByText('Refactor storage')).toBeTruthy();
  });

  it('should fall back to last path segment of cwd when no name or summary', () => {
    const session = makeSession({ name: undefined, summary: undefined, cwd: '/home/user/my-project' });
    render(<SessionList {...defaultProps} sessions={[session]} />);
    expect(screen.getByText('my-project')).toBeTruthy();
  });

  it('should render a Running badge for running sessions', () => {
    const session = makeSession({ status: 'running' });
    render(<SessionList {...defaultProps} sessions={[session]} />);
    expect(screen.getByText('Running')).toBeTruthy();
  });

  it('should render an Ended badge for exited sessions', () => {
    const session = makeSession({ status: 'exited' });
    render(<SessionList {...defaultProps} sessions={[session]} />);
    expect(screen.getByText('Ended')).toBeTruthy();
  });

  it('should render multiple sessions', () => {
    const sessions = [
      makeSession({ id: 's1', name: 'Session Alpha' }),
      makeSession({ id: 's2', name: 'Session Beta' }),
    ];
    render(<SessionList {...defaultProps} sessions={sessions} />);
    expect(screen.getByText('Session Alpha')).toBeTruthy();
    expect(screen.getByText('Session Beta')).toBeTruthy();
  });

  // ── Tags ─────────────────────────────────────────────────────────────

  it('should render session tags', () => {
    const session = makeSession({ tags: ['feature', 'docs'] });
    render(<SessionList {...defaultProps} sessions={[session]} />);
    expect(screen.getByText('feature')).toBeTruthy();
    expect(screen.getByText('docs')).toBeTruthy();
  });

  // ── Action callbacks ─────────────────────────────────────────────────

  it('should call onNew when New button is clicked', () => {
    const onNew = vi.fn();
    render(<SessionList {...defaultProps} onNew={onNew} />);
    fireEvent.click(screen.getByRole('button', { name: /new session/i }));
    expect(onNew).toHaveBeenCalledOnce();
  });

  it('should call onRefresh when Refresh button is clicked', () => {
    const onRefresh = vi.fn();
    render(<SessionList {...defaultProps} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }));
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it('should call onDelete when the delete button is clicked', () => {
    const onDelete = vi.fn();
    const session = makeSession({ id: 'del-id' });
    render(<SessionList {...defaultProps} sessions={[session]} onDelete={onDelete} />);
    const deleteBtn = screen.getByRole('button', { name: /delete session/i });
    fireEvent.click(deleteBtn);
    expect(onDelete).toHaveBeenCalledWith('del-id');
  });

  // ── Collapse/expand ──────────────────────────────────────────────────

  it('should hide sessions after clicking the group heading to collapse', () => {
    const session = makeSession({ name: 'Collapsible' });
    render(<SessionList {...defaultProps} sessions={[session]} />);

    // Session is visible initially
    expect(screen.getByText('Collapsible')).toBeTruthy();

    // Click the group heading to collapse
    const heading = screen.getByRole('button', { name: /copilot/i });
    fireEvent.click(heading);

    // Session name should no longer be visible
    expect(screen.queryByText('Collapsible')).toBeNull();
  });
});
