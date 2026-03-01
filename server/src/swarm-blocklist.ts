import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

/** Path to the owner-overridable blocklist JSON file */
const SWARM_BLOCKLIST_FILE = join(homedir(), '.copilot-remote', 'swarm-blocklist.json');

export interface BlockedPattern {
  pattern: string;       // regex string
  category: string;
  description: string;
}

export interface BlocklistValidation {
  allowed: boolean;
  blockedPattern?: string;
  category?: string;
  description?: string;
}

/** Default blocked patterns — case-insensitive regex strings */
const DEFAULT_BLOCKED_PATTERNS: BlockedPattern[] = [
  // Destructive filesystem
  { pattern: 'rm\\s+-(r|rf|fr)', category: 'filesystem', description: 'Recursive delete' },
  { pattern: '\\brmdir\\b', category: 'filesystem', description: 'Remove directory' },
  { pattern: '\\bshred\\b', category: 'filesystem', description: 'Secure delete' },
  { pattern: '\\bmkfs\\b', category: 'filesystem', description: 'Format filesystem' },
  { pattern: '\\bdd\\s+if=', category: 'filesystem', description: 'Disk write' },
  // System control
  { pattern: '\\breboot\\b', category: 'system', description: 'Reboot system' },
  { pattern: '\\bshutdown\\b', category: 'system', description: 'Shutdown system' },
  { pattern: '\\bhalt\\b', category: 'system', description: 'Halt system' },
  { pattern: '\\bpoweroff\\b', category: 'system', description: 'Power off' },
  { pattern: '\\binit\\s+[06]\\b', category: 'system', description: 'Init runlevel change' },
  // Privilege escalation
  { pattern: 'sudo\\s+rm', category: 'privilege', description: 'Sudo remove' },
  { pattern: 'sudo\\s+dd', category: 'privilege', description: 'Sudo disk write' },
  { pattern: 'chmod\\s+777', category: 'privilege', description: 'World-writable permission' },
  { pattern: 'chown\\s+root', category: 'privilege', description: 'Change owner to root' },
  // Network destructive
  { pattern: 'iptables\\s+(-F|--flush)', category: 'network', description: 'Flush firewall rules' },
  { pattern: 'ip\\s+link\\s+delete', category: 'network', description: 'Delete network interface' },
  // Kubernetes destructive
  { pattern: 'kubectl\\s+delete\\s+namespace', category: 'kubernetes', description: 'Delete namespace' },
  { pattern: 'kubectl\\s+delete\\s+all', category: 'kubernetes', description: 'Delete all resources' },
  { pattern: 'helm\\s+uninstall', category: 'kubernetes', description: 'Helm uninstall' },
  { pattern: 'kubectl\\s+drain.*--force.*--delete-emptydir-data', category: 'kubernetes', description: 'Force drain node' },
  // SQL destructive
  { pattern: 'DROP\\s+(TABLE|DATABASE)', category: 'sql', description: 'Drop table/database' },
  { pattern: '\\bTRUNCATE\\b', category: 'sql', description: 'Truncate table' },
  { pattern: 'DELETE\\s+FROM', category: 'sql', description: 'Delete rows' },
  // Fork bombs / abuse
  { pattern: ':\\(\\)\\{', category: 'abuse', description: 'Fork bomb' },
  { pattern: 'while\\s+true', category: 'abuse', description: 'Infinite loop' },
  { pattern: 'yes\\s*\\|', category: 'abuse', description: 'Yes pipe abuse' },
  // Destructive keywords (standalone words)
  { pattern: '\\b(delete|destroy|purge|erase|wipe|nuke|drop)\\b', category: 'destructive', description: 'Destructive keyword' },
];

export function getDefaultBlocklist(): BlockedPattern[] {
  return [...DEFAULT_BLOCKED_PATTERNS];
}

/**
 * Load blocklist: uses owner override file if present, otherwise defaults.
 */
export function loadBlocklist(): BlockedPattern[] {
  try {
    if (existsSync(SWARM_BLOCKLIST_FILE)) {
      const custom = JSON.parse(readFileSync(SWARM_BLOCKLIST_FILE, 'utf-8'));
      if (Array.isArray(custom)) return custom;
    }
  } catch (err) {
    console.debug('[Swarm] Failed to load custom blocklist, using defaults:', err);
  }
  return getDefaultBlocklist();
}

/**
 * Validate a command against the blocklist.
 * Returns { allowed: true } if the command passes, or details about which pattern blocked it.
 */
export function validateCommand(command: string): BlocklistValidation {
  const patterns = loadBlocklist();

  for (const entry of patterns) {
    try {
      const regex = new RegExp(entry.pattern, 'i');
      if (regex.test(command)) {
        return {
          allowed: false,
          blockedPattern: entry.pattern,
          category: entry.category,
          description: entry.description,
        };
      }
    } catch (err) {
      console.debug(`[Swarm] Invalid blocklist regex: ${entry.pattern}`, err);
    }
  }

  return { allowed: true };
}
