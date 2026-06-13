#!/usr/bin/env node
/**
 * telegram-lock.mjs — manage the bridge session lock during PROCESSING.
 *
 * The listening side (telegram-poll.mjs) holds the lock when it hands messages
 * to the agent. While the agent then does work (reply, git, long jobs), use
 * this CLI to keep the lock warm so a concurrent cron tick yields until the
 * heavy job finishes — closing the "overlap during processing" gap.
 *
 * Every call needs the SAME `--owner <id>` the run used for polling.
 *
 * Commands:
 *   refresh --owner X            Heartbeat once (stamp the lock fresh).
 *   release --owner X            Mark the lock released (a write, never a delete).
 *   status                       Print the current lock JSON (or null).
 *   guard --owner X -- <cmd...>  Run <cmd> while heartbeating the lock every 30s
 *                                for its whole duration; propagates the child's
 *                                exit code. Leaves the lock HELD on exit (the
 *                                agent releases explicitly when the chat is cold).
 *
 * Examples:
 *   node telegram-lock.mjs guard --owner run-123 -- node some-long-job.mjs
 *   node telegram-lock.mjs release --owner run-123
 */

import { spawn } from 'child_process';
import {
  loadDotEnv, logBridge,
  acquireLock, refreshLock, releaseLock, lockState, LOCK_TTL_MS,
} from './telegram.mjs';

loadDotEnv();

const argv = process.argv.slice(2);
const cmd = argv[0];

function getOwner() {
  const i = argv.indexOf('--owner');
  return i >= 0 ? String(argv[i + 1] || '') : '';
}

function requireOwner() {
  const o = getOwner();
  if (!o) { process.stderr.write('--owner <id> is required\n'); process.exit(2); }
  return o;
}

if (cmd === 'status') {
  process.stdout.write(JSON.stringify(lockState()) + '\n');
} else if (cmd === 'refresh') {
  const o = requireOwner();
  refreshLock(o);
  logBridge('LOCK.heartbeat', `owner=${o}`);
  process.stdout.write(JSON.stringify({ refreshed: true, owner: o }) + '\n');
} else if (cmd === 'release') {
  const o = requireOwner();
  releaseLock(o);
  logBridge('LOCK.released', `owner=${o} (explicit)`);
  process.stdout.write(JSON.stringify({ released: true, owner: o }) + '\n');
} else if (cmd === 'guard') {
  const o = requireOwner();
  const sep = argv.indexOf('--');
  const child = sep >= 0 ? argv.slice(sep + 1) : [];
  if (!child.length) { process.stderr.write('guard needs: -- <command...>\n'); process.exit(2); }

  // Make sure we own the lock, then heartbeat for the whole child lifetime.
  acquireLock(o);
  const HEARTBEAT_MS = 30_000; // well under the 5-min TTL
  logBridge('GUARD.start', `owner=${o} cmd="${child.join(' ')}" (heartbeat ${HEARTBEAT_MS / 1000}s, ttl ${LOCK_TTL_MS / 1000}s)`);
  const beat = setInterval(() => { refreshLock(o); logBridge('LOCK.heartbeat', `owner=${o} (guard)`); }, HEARTBEAT_MS);

  const p = spawn(child[0], child.slice(1), { stdio: 'inherit' });
  const stop = (code, signal) => {
    clearInterval(beat);
    refreshLock(o); // final stamp; leave HELD for the agent to release when cold
    logBridge('GUARD.end', `owner=${o} exit=${code ?? `sig:${signal}`} — lock HELD`);
    process.exit(code == null ? 1 : code);
  };
  p.on('exit', stop);
  p.on('error', (e) => { process.stderr.write('guard spawn failed: ' + e.message + '\n'); stop(1); });
} else {
  process.stderr.write('usage: telegram-lock.mjs <refresh|release|status|guard> --owner <id> [-- cmd...]\n');
  process.exit(2);
}
