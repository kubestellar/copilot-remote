/**
 * Tests for swarm command blocklist — validates dangerous commands are blocked.
 */
import { describe, it, expect } from 'vitest';
import { validateCommand, getDefaultBlocklist } from '../swarm-blocklist.js';

describe('Swarm blocklist', () => {
  // ── Default blocklist structure ───────────────────────────────────────

  it('should have default blocked patterns', () => {
    const defaults = getDefaultBlocklist();
    expect(defaults.length).toBeGreaterThan(20);
    expect(defaults.every(p => p.pattern && p.category && p.description)).toBe(true);
  });

  it('should return independent copies from getDefaultBlocklist', () => {
    const a = getDefaultBlocklist();
    const b = getDefaultBlocklist();
    a.pop();
    expect(b.length).toBeGreaterThan(a.length);
  });

  // ── Filesystem destructive ────────────────────────────────────────────

  it('should block rm -rf', () => {
    const r = validateCommand('rm -rf /');
    expect(r.allowed).toBe(false);
    expect(r.category).toBe('filesystem');
  });

  it('should block rm -r (without f)', () => {
    expect(validateCommand('rm -r /tmp/data').allowed).toBe(false);
  });

  it('should block rm -fr (reversed flags)', () => {
    expect(validateCommand('rm -fr /tmp').allowed).toBe(false);
  });

  it('should block shred', () => {
    expect(validateCommand('shred /dev/sda').allowed).toBe(false);
  });

  it('should block mkfs', () => {
    expect(validateCommand('mkfs.ext4 /dev/sdb1').allowed).toBe(false);
  });

  it('should block dd if=', () => {
    expect(validateCommand('dd if=/dev/zero of=/dev/sda').allowed).toBe(false);
  });

  it('should block rmdir', () => {
    expect(validateCommand('rmdir /important').allowed).toBe(false);
  });

  // ── System control ────────────────────────────────────────────────────

  it('should block reboot', () => {
    expect(validateCommand('reboot').allowed).toBe(false);
  });

  it('should block shutdown', () => {
    expect(validateCommand('shutdown -h now').allowed).toBe(false);
  });

  it('should block halt', () => {
    expect(validateCommand('halt').allowed).toBe(false);
  });

  it('should block poweroff', () => {
    expect(validateCommand('poweroff').allowed).toBe(false);
  });

  it('should block init 0', () => {
    expect(validateCommand('init 0').allowed).toBe(false);
  });

  // ── Privilege escalation ──────────────────────────────────────────────

  it('should block sudo rm', () => {
    expect(validateCommand('sudo rm -rf /').allowed).toBe(false);
  });

  it('should block sudo dd', () => {
    expect(validateCommand('sudo dd if=/dev/zero of=/dev/sda').allowed).toBe(false);
  });

  it('should block chmod 777', () => {
    expect(validateCommand('chmod 777 /etc/passwd').allowed).toBe(false);
  });

  it('should block chown root', () => {
    expect(validateCommand('chown root /tmp/exploit').allowed).toBe(false);
  });

  // ── Network destructive ───────────────────────────────────────────────

  it('should block iptables flush', () => {
    expect(validateCommand('iptables -F').allowed).toBe(false);
    expect(validateCommand('iptables --flush').allowed).toBe(false);
  });

  it('should block ip link delete', () => {
    expect(validateCommand('ip link delete eth0').allowed).toBe(false);
  });

  // ── Kubernetes destructive ────────────────────────────────────────────

  it('should block kubectl delete namespace', () => {
    expect(validateCommand('kubectl delete namespace production').allowed).toBe(false);
  });

  it('should block kubectl delete all', () => {
    expect(validateCommand('kubectl delete all --all').allowed).toBe(false);
  });

  it('should block helm uninstall', () => {
    expect(validateCommand('helm uninstall my-release').allowed).toBe(false);
  });

  // ── SQL destructive ───────────────────────────────────────────────────

  it('should block DROP TABLE', () => {
    expect(validateCommand('DROP TABLE users').allowed).toBe(false);
  });

  it('should block DROP DATABASE', () => {
    expect(validateCommand('DROP DATABASE production').allowed).toBe(false);
  });

  it('should block TRUNCATE', () => {
    expect(validateCommand('TRUNCATE TABLE logs').allowed).toBe(false);
  });

  it('should block DELETE FROM', () => {
    expect(validateCommand('DELETE FROM users WHERE 1=1').allowed).toBe(false);
  });

  // ── Abuse patterns ────────────────────────────────────────────────────

  it('should block fork bomb', () => {
    expect(validateCommand(':(){:|:&};:').allowed).toBe(false);
  });

  it('should block while true loops', () => {
    expect(validateCommand('while true; do echo x; done').allowed).toBe(false);
  });

  it('should block yes pipe', () => {
    expect(validateCommand('yes | rm -i file').allowed).toBe(false);
  });

  // ── Case insensitivity ────────────────────────────────────────────────

  it('should block commands case-insensitively', () => {
    expect(validateCommand('DROP table USERS').allowed).toBe(false);
    expect(validateCommand('REBOOT').allowed).toBe(false);
    expect(validateCommand('Shutdown -h now').allowed).toBe(false);
  });

  // ── Safe commands should pass ─────────────────────────────────────────

  it('should allow ls', () => {
    expect(validateCommand('ls -la').allowed).toBe(true);
  });

  it('should allow cat', () => {
    expect(validateCommand('cat /etc/hostname').allowed).toBe(true);
  });

  it('should allow git commands', () => {
    expect(validateCommand('git status').allowed).toBe(true);
    expect(validateCommand('git commit -m "update"').allowed).toBe(true);
  });

  it('should allow kubectl get', () => {
    expect(validateCommand('kubectl get pods -A').allowed).toBe(true);
  });

  it('should allow npm commands', () => {
    expect(validateCommand('npm install express').allowed).toBe(true);
    expect(validateCommand('npm run build').allowed).toBe(true);
  });

  it('should allow echo', () => {
    expect(validateCommand('echo "hello world"').allowed).toBe(true);
  });

  // ── Blocked result structure ──────────────────────────────────────────

  it('should return full details when blocking', () => {
    const r = validateCommand('rm -rf /');
    expect(r.allowed).toBe(false);
    expect(r.blockedPattern).toBeDefined();
    expect(r.category).toBeDefined();
    expect(r.description).toBeDefined();
  });

  it('should return only allowed:true for safe commands', () => {
    const r = validateCommand('pwd');
    expect(r).toEqual({ allowed: true });
  });
});
