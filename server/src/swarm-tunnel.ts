import { EventEmitter } from 'events';
import { spawn, ChildProcess, execSync } from 'child_process';

/** Delay before first reconnect attempt (ms) */
const TUNNEL_RECONNECT_DELAY_MS = 5_000;

/** Maximum delay between reconnect attempts (ms) */
const TUNNEL_MAX_RECONNECT_DELAY_MS = 60_000;

/** Multiplier for exponential backoff */
const TUNNEL_BACKOFF_MULTIPLIER = 2;

/** Regex to extract cloudflared tunnel URL from stdout */
const CLOUDFLARED_URL_REGEX = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

/** Regex to extract localtunnel URL from stdout */
const LOCALTUNNEL_URL_REGEX = /your url is:\s*(https:\/\/[^\s]+)/i;

export type TunnelProvider = 'cloudflared' | 'localtunnel';

export interface TunnelStatus {
  running: boolean;
  url: string | null;
  provider: TunnelProvider | null;
  error: string | null;
}

/**
 * Manages a tunnel process (cloudflared or localtunnel) for exposing
 * the server to the internet.
 *
 * Events:
 *   'url'   - emitted when a public URL is available (url: string)
 *   'error' - emitted on tunnel errors (error: Error)
 *   'close' - emitted when tunnel process exits
 */
export class SwarmTunnel extends EventEmitter {
  private process: ChildProcess | null = null;
  private _url: string | null = null;
  private _provider: TunnelProvider | null = null;
  private _error: string | null = null;
  private _running = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = TUNNEL_RECONNECT_DELAY_MS;
  private port = 0;
  private shouldReconnect = false;

  getStatus(): TunnelStatus {
    return {
      running: this._running,
      url: this._url,
      provider: this._provider,
      error: this._error,
    };
  }

  /**
   * Start a tunnel exposing the given port.
   * Auto-detects cloudflared or falls back to localtunnel.
   */
  async start(port: number): Promise<string> {
    if (this._running) {
      throw new Error('Tunnel is already running');
    }

    this.port = port;
    this.shouldReconnect = true;
    this.reconnectDelay = TUNNEL_RECONNECT_DELAY_MS;

    const provider = detectProvider();
    if (!provider) {
      const msg = 'No tunnel provider found. Install cloudflared (brew install cloudflared) or npx localtunnel.';
      this._error = msg;
      throw new Error(msg);
    }

    this._provider = provider;
    return this.spawnTunnel(provider, port);
  }

  /**
   * Stop the tunnel and prevent auto-reconnect.
   */
  stop(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.process) {
      this.process.kill('SIGTERM');
      this.process = null;
    }
    this._running = false;
    this._url = null;
    this._error = null;
    this._provider = null;
    this.emit('close');
  }

  private spawnTunnel(provider: TunnelProvider, port: number): Promise<string> {
    return new Promise((resolve, reject) => {
      let resolved = false;

      const args = provider === 'cloudflared'
        ? ['tunnel', '--url', `http://localhost:${port}`, '--no-autoupdate']
        : ['localtunnel', '--port', String(port)];

      const cmd = provider === 'cloudflared' ? 'cloudflared' : 'npx';

      console.log(`[Swarm] Starting ${provider} tunnel on port ${port}...`);
      const child = spawn(cmd, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.process = child;
      this._running = true;
      this._error = null;

      const urlRegex = provider === 'cloudflared' ? CLOUDFLARED_URL_REGEX : LOCALTUNNEL_URL_REGEX;

      const handleOutput = (data: Buffer) => {
        const line = data.toString();
        console.debug(`[Swarm/${provider}] ${line.trim()}`);

        const match = line.match(urlRegex);
        if (match && !resolved) {
          const url = provider === 'localtunnel' ? match[1] : match[0];
          this._url = url;
          resolved = true;
          this.reconnectDelay = TUNNEL_RECONNECT_DELAY_MS;
          this.emit('url', url);
          resolve(url);
        }
      };

      child.stdout?.on('data', handleOutput);
      child.stderr?.on('data', handleOutput);

      child.on('error', (err) => {
        this._error = err.message;
        this._running = false;
        this.emit('error', err);
        if (!resolved) {
          resolved = true;
          reject(err);
        }
      });

      child.on('close', (code) => {
        this._running = false;
        const wasUrl = this._url;
        this._url = null;

        if (!resolved) {
          resolved = true;
          reject(new Error(`${provider} exited with code ${code} before providing a URL`));
        }

        if (wasUrl) {
          this.emit('close');
        }

        // Auto-reconnect if stop() wasn't called
        if (this.shouldReconnect) {
          console.log(`[Swarm] Tunnel closed, reconnecting in ${this.reconnectDelay}ms...`);
          this.reconnectTimer = setTimeout(() => {
            this.spawnTunnel(provider, this.port).catch((err) => {
              this.emit('error', err);
            });
          }, this.reconnectDelay);

          // Exponential backoff
          this.reconnectDelay = Math.min(
            this.reconnectDelay * TUNNEL_BACKOFF_MULTIPLIER,
            TUNNEL_MAX_RECONNECT_DELAY_MS,
          );
        }
      });

      // Timeout: if no URL within 30 seconds, reject
      const URL_TIMEOUT_MS = 30_000;
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          const msg = `${provider} did not provide a URL within ${URL_TIMEOUT_MS / 1000}s`;
          this._error = msg;
          reject(new Error(msg));
        }
      }, URL_TIMEOUT_MS);
    });
  }
}

/**
 * Detect which tunnel provider is available.
 * Prefers cloudflared, falls back to localtunnel (via npx).
 */
function detectProvider(): TunnelProvider | null {
  try {
    execSync('which cloudflared', { stdio: 'ignore' });
    return 'cloudflared';
  } catch {
    // cloudflared not found
  }
  try {
    execSync('which npx', { stdio: 'ignore' });
    return 'localtunnel';
  } catch {
    // npx not found either
  }
  return null;
}

/** Singleton tunnel instance */
export const swarmTunnel = new SwarmTunnel();
