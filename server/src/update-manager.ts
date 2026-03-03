import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

function git(cmd: string): string {
  return execSync(`git ${cmd}`, { cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 30_000 }).trim();
}

export interface UpdateCheckResult {
  updateAvailable: boolean;
  currentCommit: string;
  latestCommit: string;
  behindBy: number;
  dirty: boolean;
}

export interface UpdateApplyResult {
  success: boolean;
  message: string;
}

export function checkForUpdate(): UpdateCheckResult {
  // Fetch latest from remote
  git('fetch origin main');

  const currentCommit = git('rev-parse HEAD');
  const latestCommit = git('rev-parse origin/main');
  const dirty = git('status --porcelain').length > 0;

  let behindBy = 0;
  if (currentCommit !== latestCommit) {
    const count = git(`rev-list --count HEAD..origin/main`);
    behindBy = parseInt(count, 10) || 0;
  }

  return {
    updateAvailable: currentCommit !== latestCommit && behindBy > 0,
    currentCommit,
    latestCommit,
    behindBy,
    dirty,
  };
}

export function applyUpdate(): UpdateApplyResult {
  // Safety: refuse if working tree is dirty
  const dirty = git('status --porcelain');
  if (dirty.length > 0) {
    return { success: false, message: 'Cannot update: uncommitted changes detected. Commit or stash them first.' };
  }

  try {
    git('pull --rebase origin main');
    execSync('npm install', { cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 120_000 });
    execSync('npm run build', { cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 120_000 });

    // Schedule graceful restart after response is sent
    setTimeout(() => {
      console.log('[Update] Restarting server after update...');
      process.exit(0);
    }, 1000);

    const newCommit = git('rev-parse --short HEAD');
    return { success: true, message: `Updated to ${newCommit}. Server restarting...` };
  } catch (err: any) {
    return { success: false, message: `Update failed: ${err.message}` };
  }
}
