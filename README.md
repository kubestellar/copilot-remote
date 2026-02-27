# ⚡ Copilot Remote

Control AI coding agents from any device. Manage Copilot CLI and Claude Code sessions, launch tiled web terminals with tmux, and stream real-time output — all from a mobile-friendly interface over your local network.

## How It Works

```
+---------------------+       local WiFi        +-------------------------+
|  Phone / Browser    |  <-- WebSocket+REST --> |  Laptop                 |
|  (PWA)              |      :5173 -> :3001     |  (Node.js server)       |
|                     |                         |                         |
|  Chat UI            |                         |  Spawns AI CLIs         |
|  Tiled terminals    |                         |  Manages tmux sessions  |
|  Session list       |                         |  ACP streaming          |
|  Tags / rename      |                         |  Reads ~/.copilot/      |
+---------------------+                         +-------------------------+
```

The **server** runs on your laptop alongside your AI CLI installations (Copilot CLI, Claude Code). It spawns and manages AI processes via ACP streaming, provides interactive web terminals backed by tmux and node-pty, reads historical sessions from `~/.copilot/session-state/`, and streams everything over WebSocket.

The **web app** is a React PWA built with [GitHub Primer](https://primer.style/react/) and xterm.js. It connects to the server over your local network, provides a chat interface with full terminal emulation, tiled multi-terminal layouts, and lets you manage sessions with custom names, tags, and real-time status.

## Features

### Core
- **📋 Session Browser** — Lists all AI CLI sessions: running (managed), active (detected via filesystem), and historical (from `~/.copilot/session-state/`)
- **🚀 Start Sessions** — Launch new Copilot or Claude sessions with a prompt, working directory, or resume an existing session
- **💬 iMessage-style Chat** — Send messages and see responses as compact chat bubbles with markdown rendering, inline 🤖 icons, and short timestamps
- **⚡ ACP Streaming** — Real-time streaming via the Agent Client Protocol with persistent `copilot --acp` processes for multi-turn conversations with live text chunks and tool call status
- **🔄 Resume Sessions** — Pick up where you left off with `--resume <sessionId>`
- **🗑️ Delete Sessions** — Remove sessions directly from the session list

### Web Terminals
- **🖥️ Interactive Terminals** — Full terminal emulation powered by xterm.js and node-pty, with cursor blinking, link detection, and responsive sizing
- **📐 Tile Mode** — Multiple terminals in a tiled grid layout on desktop, each showing a live xterm.js window with independent focus and keyboard shortcuts
- **🔗 Tmux Integration** — Terminals automatically run inside tmux sessions (`cr-<id>`) with mouse support, allowing sessions to persist and be reattached
- **🤖 Auto-launch AI CLI** — Automatically detects installed AI tools (Copilot CLI, Claude Code) and launches them in new terminals
- **📋 Tmux Copy** — Copy tmux session info from tile headers for easy external attach
- **⌨️ Keyboard Shortcuts** — Navigate and manage tiles with keyboard shortcuts

### Organization
- **🏷️ Session Names** — Rename sessions inline with a tap on the pencil icon
- **🎨 Color-coded Tags** — Add tags like `copilot-phone`, `bug`, `feature`, `docs` with automatic color coding
- **📌 Session Persistence** — Last active session is remembered across browser refreshes via localStorage

### Mobile
- **📱 Responsive Layout** — On mobile (<768px), sidebar and chat toggle with a back button for navigation
- **📱 Installable PWA** — Add to home screen on iOS/Android, runs in standalone mode without browser chrome
- **🌙 Dark Mode** — Proper dark theme using Primer's `dark_dimmed` scheme with explicit high-contrast colors

### Reliability
- **🔁 Auto-reconnect** — WebSocket reconnects automatically with 3-second backoff; terminals auto-reconnect on server restart
- **🔄 Auto-restart** — `start.sh` script keeps both servers alive with infinite restart loops
- **🔒 Token Auth** — Server generates a random 256-bit token on first run; all API/WebSocket calls require it
- **🤖 Auto-QA** — GitHub Actions workflow runs hourly quality checks (build, lint, security, a11y, performance) with rotating focus areas

### Performance
- **⚡ Memoized Rendering** — `React.memo` on MessageBubble and `useMemo` on message arrays prevent re-rendering 500+ messages on every keystroke
- **📊 Smart Filtering** — Empty-content events (tool call artifacts) are filtered out, keeping only meaningful messages
- **⏸️ Polling Pause** — Session list polling pauses during inline editing to prevent input lag

## Prerequisites

- **Node.js 18+** and **npm 9+**
- **tmux** installed (`brew install tmux` / `apt install tmux`)
- **GitHub Copilot CLI** and/or **Claude Code** installed and authenticated
- Laptop and phone on the **same WiFi network**

## Installation

```bash
git clone https://github.com/kubestellar/copilot-remote.git
cd copilot-remote
npm install
```

## Usage

### 1. Start the servers

**Recommended** — persistent with auto-restart:

```bash
./start.sh
```

This launches both the **API server** (port 3001) and the **Vite dev server** (port 5173) with automatic restart on crash. Logs go to `logs/server.log` and `logs/vite.log`.

**Alternative** — manual start:

```bash
npm run dev
```

On first run, you'll see:

```
🚀 Copilot Remote server running on http://0.0.0.0:3001
👀 Watching 12 session(s) for live updates (polling every 1500ms)

🔑 Auth token: a1b2c3d4e5f6...

   Use this token to connect from your phone.
   It's saved in ~/.copilot-remote/auth-token
```

### 2. Open on your phone

Find your laptop's local IP:

```bash
# macOS
ipconfig getifaddr en0

# Linux
hostname -I | awk '{print $1}'
```

Open `http://<laptop-ip>:5173` on your phone's browser.

### 3. Connect

On first visit, you'll see a setup screen. Enter:
- **Auth Token** — the token displayed when the server started
- **Server URL** (optional) — only needed if not using the Vite proxy (e.g., `http://192.168.1.100:3001`)

### 4. Start a session

Tap **+ New**, enter a prompt like `"Fix the failing tests in src/"`, optionally set a working directory, and hit **Create Session**. Copilot starts working and you'll see its output stream in real-time as chat messages.

### 5. Manage sessions

- **Rename** — Tap the ✏️ icon next to any session to set a custom name
- **Tag** — Tap the 🏷️ icon to add color-coded tags (e.g., `bug`, `feature`, `docs`)
- **Resume** — Tap any ended session and hit **Resume** or type a follow-up message

### 6. Install as PWA

On your phone's browser, tap **Share → Add to Home Screen** (iOS) or the install banner (Android/Chrome). The app runs in standalone mode without browser chrome.

## Project Structure

```
copilot-remote/
├── server/                     # Node.js backend
│   ├── src/
│   │   ├── index.ts            # Express + WebSocket server, REST API routes
│   │   ├── session-manager.ts  # PTY lifecycle: spawn, track, stream, kill
│   │   ├── session-store.ts    # Reads ~/.copilot/session-state/ for history
│   │   ├── session-watcher.ts  # Live-tails events.jsonl with byte-offset reads
│   │   ├── session-meta.ts     # CRUD for session names/tags in ~/.copilot-remote/
│   │   ├── terminal-manager.ts # Web terminal + tmux session management
│   │   ├── acp-manager.ts      # Agent Control Protocol streaming for AI CLIs
│   │   ├── auth.ts             # Token generation, middleware, WS validation
│   │   └── types.ts            # Shared TypeScript interfaces
│   ├── package.json
│   └── tsconfig.json
├── web/                        # React PWA frontend
│   ├── src/
│   │   ├── App.tsx             # Root: responsive layout, state, WS handler
│   │   ├── main.tsx            # Entry: Primer ThemeProvider (dark_dimmed)
│   │   ├── components/
│   │   │   ├── SessionList.tsx     # Compact session list with inline rename/tags
│   │   │   ├── ChatView.tsx        # iMessage-style chat with back navigation
│   │   │   ├── MessageBubble.tsx   # Memoized message with inline markdown
│   │   │   ├── TerminalView.tsx    # xterm.js tiled terminal grid with tmux
│   │   │   ├── NewSessionDialog.tsx# Create/resume session form
│   │   │   └── ConnectionStatus.tsx# Green/red dot indicator
│   │   ├── hooks/
│   │   │   ├── useWebSocket.ts     # WS connection with auto-reconnect
│   │   │   └── useSessions.ts      # Session list polling with pause support
│   │   ├── lib/
│   │   │   └── api.ts              # REST client (fetch wrapper)
│   │   └── types.ts                # Session, ChatMessage interfaces
│   ├── vite.config.ts          # Vite + PWA + proxy config
│   ├── index.html              # Dark mode data attributes for Primer CSS
│   ├── package.json
│   └── tsconfig.json
├── .github/
│   └── workflows/
│       └── auto-qa.yml         # Hourly quality checks with rotating focus
├── start.sh                    # Persistent startup with auto-restart
├── package.json                # Root workspace (npm workspaces)
└── README.md
```

## API Reference

All endpoints (except health) require `Authorization: Bearer <token>` header.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/health` | Server status (no auth required) |
| `GET` | `/api/sessions` | List all sessions with names, tags, and status |
| `POST` | `/api/sessions` | Start new session `{ prompt?, cwd?, resume? }` |
| `GET` | `/api/sessions/:id` | Session details + last 500 messages |
| `DELETE` | `/api/sessions/:id` | Kill a running session |
| `POST` | `/api/sessions/:id/send` | Send message `{ text }` to running session |
| `PATCH` | `/api/sessions/:id/meta` | Update session name `{ name }` |
| `POST` | `/api/sessions/:id/tags/:tag` | Add a tag to a session |
| `DELETE` | `/api/sessions/:id/tags/:tag` | Remove a tag from a session |

### WebSocket

Connect to `/ws?token=<token>` for real-time streaming.

**Client → Server:**
```json
{ "type": "subscribe", "sessionId": "..." }
{ "type": "unsubscribe", "sessionId": "..." }
{ "type": "input", "sessionId": "...", "text": "..." }
```

**Server → Client:**
```json
{ "type": "message", "sessionId": "...", "message": { "role": "copilot", "content": "...", "timestamp": "..." } }
{ "type": "status", "sessionId": "...", "status": "running" }
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | API server port |

**Server data:**
- `~/.copilot-remote/auth-token` — Auth token (auto-generated, `chmod 600`)
- `~/.copilot-remote/session-meta.json` — Custom session names and tags

**Session data** is read from `~/.copilot/session-state/` (Copilot CLI's native storage). The server never modifies Copilot's files.

## Tech Stack

| Layer | Technology |
|-------|------------|
| Server runtime | Node.js + TypeScript |
| HTTP framework | Express 5 |
| WebSocket | ws |
| Terminal PTY | node-pty |
| Terminal mux | tmux |
| Session parsing | yaml (for workspace.yaml), line-by-line events.jsonl |
| Frontend framework | React 18 |
| UI components | @primer/react (GitHub's design system) |
| Terminal emulator | @xterm/xterm |
| Icons | @primer/octicons-react |
| Markdown | react-markdown |
| Build tool | Vite 6 |
| PWA | vite-plugin-pwa |
| CI/CD | GitHub Actions (auto-qa workflow) |

## Auto-QA

The repository includes an automated quality assurance workflow (`.github/workflows/auto-qa.yml`) that runs hourly and checks:

**Every run:**
- TypeScript compilation (server + web)
- Vite production build
- Bundle size analysis
- npm audit for vulnerabilities

**Rotating focus (one per day):**
| Day | Focus Area |
|-----|------------|
| Mon | ⚡ Performance (re-renders, bundle size, memoization) |
| Tue | 🔒 Security (XSS, token handling, CORS) |
| Wed | ♿ Accessibility (ARIA, touch targets, contrast) |
| Thu | 📱 UX & Mobile (responsive, PWA, touch-friendly) |
| Fri | ✨ Features (WebSocket, session management) |
| Sat | 🛡️ Resilience (error handling, reconnection) |

Issues are auto-created in GitHub with labels, reproduction steps, and fix guidance.

## Roadmap

- [x] Session names and tags
- [x] Responsive mobile layout
- [x] Dark mode with proper Primer theming
- [x] Live-tailing of active sessions
- [x] Auto-restart server script
- [x] Auto-QA workflow
- [x] Web terminals with xterm.js + node-pty
- [x] Tmux integration for persistent terminals
- [x] Tile mode for multi-terminal grid layout
- [x] Auto-launch AI CLI (Copilot / Claude)
- [x] ACP streaming for real-time AI responses
- [x] Terminal auto-reconnect on server restart
- [x] Delete sessions from session list
- [x] Keyboard shortcuts for tile navigation
- [ ] Multi-user collaborative sessions
- [ ] Slack integration for team collaboration
- [ ] Push notifications when sessions need input or complete
- [ ] Tunnel support (ngrok / Cloudflare) for remote access
- [ ] Quick actions: approve tool use, cancel operations
- [ ] File browser for session artifacts

## License

Apache-2.0
