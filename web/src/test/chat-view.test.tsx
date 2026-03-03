/**
 * Component tests for ChatView — rendering messages, sending input,
 * and session control (resume / kill).
 *
 * The `api` module is mocked so no real HTTP requests are made.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ChatView } from '../components/ChatView';
import type { Session, ChatMessage } from '../types';

// Mock the api module
vi.mock('../lib/api', () => ({
  api: {
    getSession: vi.fn().mockResolvedValue({ messages: [] }),
    killSession: vi.fn().mockResolvedValue({ killed: true }),
  },
}));

import { api } from '../lib/api';

const makeSession = (overrides: Partial<Session> = {}): Session => ({
  id: 'session-abc',
  cwd: '/home/user/project',
  status: 'running',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...overrides,
});

const makeMessage = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'msg-1',
  role: 'copilot',
  content: 'Hello from Copilot',
  timestamp: new Date().toISOString(),
  ...overrides,
});

const defaultProps = {
  session: makeSession(),
  messages: [] as ChatMessage[],
  onSend: vi.fn(),
  onResume: vi.fn(),
};

describe('ChatView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (api.getSession as ReturnType<typeof vi.fn>).mockResolvedValue({ messages: [] });
  });

  // ── Session header ────────────────────────────────────────────────────

  it('should render the session id when no name or summary', async () => {
    const session = makeSession({ id: 'abcdef123456' });
    render(<ChatView {...defaultProps} session={session} />);
    // The id appears in both the title (first 12 chars) and the id row
    await waitFor(() => expect(screen.getAllByText('abcdef123456').length).toBeGreaterThan(0));
  });

  it('should render the session name when provided', async () => {
    const session = makeSession({ name: 'My Feature Work' });
    render(<ChatView {...defaultProps} session={session} />);
    await waitFor(() => expect(screen.getByText('My Feature Work')).toBeTruthy());
  });

  it('should display the cwd path in the header', async () => {
    const session = makeSession({ cwd: '/home/user/my-repo' });
    render(<ChatView {...defaultProps} session={session} />);
    await waitFor(() => expect(screen.getByText('/home/user/my-repo')).toBeTruthy());
  });

  it('should show a "running" label for a running session', async () => {
    render(<ChatView {...defaultProps} session={makeSession({ status: 'running' })} />);
    await waitFor(() => expect(screen.getByText('running')).toBeTruthy());
  });

  it('should show an "ended" label for an exited session', async () => {
    render(<ChatView {...defaultProps} session={makeSession({ status: 'exited' })} />);
    await waitFor(() => expect(screen.getByText('ended')).toBeTruthy());
  });

  // ── Empty state ──────────────────────────────────────────────────────

  it('should show "Waiting for output" when running with no messages', async () => {
    render(<ChatView {...defaultProps} session={makeSession({ status: 'running' })} messages={[]} />);
    await waitFor(() => expect(screen.getByText('Waiting for output...')).toBeTruthy());
  });

  it('should show "No messages" for exited sessions with no messages', async () => {
    render(<ChatView {...defaultProps} session={makeSession({ status: 'exited' })} messages={[]} />);
    await waitFor(() => expect(screen.getByText('No messages in this session')).toBeTruthy());
  });

  // ── Message rendering ─────────────────────────────────────────────────

  it('should render a message passed via props', async () => {
    const msg = makeMessage({ role: 'user', content: 'What is the status?' });
    render(<ChatView {...defaultProps} messages={[msg]} />);
    await waitFor(() => expect(screen.getByText('What is the status?')).toBeTruthy());
  });

  it('should render a copilot message', async () => {
    const msg = makeMessage({ role: 'copilot', content: 'Everything is fine.' });
    render(<ChatView {...defaultProps} messages={[msg]} />);
    await waitFor(() => expect(screen.getByText('Everything is fine.')).toBeTruthy());
  });

  it('should render multiple messages in order', async () => {
    const msgs = [
      makeMessage({ id: 'm1', role: 'user', content: 'First message' }),
      makeMessage({ id: 'm2', role: 'copilot', content: 'Second message' }),
    ];
    render(<ChatView {...defaultProps} messages={msgs} />);
    await waitFor(() => {
      expect(screen.getByText('First message')).toBeTruthy();
      expect(screen.getByText('Second message')).toBeTruthy();
    });
  });

  // ── Input and send ────────────────────────────────────────────────────

  it('should render a message input box', async () => {
    render(<ChatView {...defaultProps} />);
    await waitFor(() => expect(screen.getByRole('textbox', { name: /message input/i })).toBeTruthy());
  });

  it('should call onSend when Enter is pressed with text', async () => {
    const onSend = vi.fn();
    render(<ChatView {...defaultProps} onSend={onSend} />);
    const input = await screen.findByRole('textbox', { name: /message input/i });

    fireEvent.change(input, { target: { value: 'Fix the bug' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });

    expect(onSend).toHaveBeenCalledWith('Fix the bug');
  });

  it('should not call onSend for empty input on Enter', async () => {
    const onSend = vi.fn();
    render(<ChatView {...defaultProps} onSend={onSend} />);
    const input = await screen.findByRole('textbox', { name: /message input/i });

    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('should not call onSend when Shift+Enter is pressed (newline)', async () => {
    const onSend = vi.fn();
    render(<ChatView {...defaultProps} onSend={onSend} />);
    const input = await screen.findByRole('textbox', { name: /message input/i });

    fireEvent.change(input, { target: { value: 'multiline' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('should clear input after sending', async () => {
    render(<ChatView {...defaultProps} />);
    const input = await screen.findByRole('textbox', { name: /message input/i });

    fireEvent.change(input, { target: { value: 'hello' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });

    expect((input as HTMLInputElement).value).toBe('');
  });

  it('should call onSend when Send button is clicked', async () => {
    const onSend = vi.fn();
    render(<ChatView {...defaultProps} onSend={onSend} />);
    const input = await screen.findByRole('textbox', { name: /message input/i });

    fireEvent.change(input, { target: { value: 'Click send' } });
    fireEvent.click(screen.getByRole('button', { name: /^send$/i }));

    expect(onSend).toHaveBeenCalledWith('Click send');
  });

  // ── Session controls ─────────────────────────────────────────────────

  it('should show a Stop button for running sessions', async () => {
    render(<ChatView {...defaultProps} session={makeSession({ status: 'running' })} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /stop session/i })).toBeTruthy());
  });

  it('should show a Resume button for exited sessions', async () => {
    render(<ChatView {...defaultProps} session={makeSession({ status: 'exited' })} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /resume session/i })).toBeTruthy());
  });

  it('should call onResume when Resume button is clicked', async () => {
    const onResume = vi.fn();
    const session = makeSession({ id: 'res-id', status: 'exited' });
    render(<ChatView {...defaultProps} session={session} onResume={onResume} />);
    const resumeBtn = await screen.findByRole('button', { name: /resume session/i });
    fireEvent.click(resumeBtn);
    expect(onResume).toHaveBeenCalledWith('res-id');
  });

  it('should call api.killSession when Stop button is clicked', async () => {
    const session = makeSession({ status: 'running' });
    render(<ChatView {...defaultProps} session={session} />);
    const stopBtn = await screen.findByRole('button', { name: /stop session/i });
    fireEvent.click(stopBtn);
    await waitFor(() => expect(api.killSession).toHaveBeenCalledWith(session.id));
  });

  // ── Back button ──────────────────────────────────────────────────────

  it('should not render a Back button when onBack is not provided', async () => {
    render(<ChatView {...defaultProps} />);
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /back to sessions/i })).toBeNull()
    );
  });

  it('should render a Back button when onBack is provided', async () => {
    const onBack = vi.fn();
    render(<ChatView {...defaultProps} onBack={onBack} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /back to sessions/i })).toBeTruthy());
  });

  it('should call onBack when the Back button is clicked', async () => {
    const onBack = vi.fn();
    render(<ChatView {...defaultProps} onBack={onBack} />);
    const backBtn = await screen.findByRole('button', { name: /back to sessions/i });
    fireEvent.click(backBtn);
    expect(onBack).toHaveBeenCalledOnce();
  });
});
