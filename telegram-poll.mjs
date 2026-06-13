#!/usr/bin/env node
/**
 * telegram-poll.mjs — you → Claude.
 *
 * Fetches your new messages (since the last processed update) and prints them
 * as JSON to stdout. The stored offset is advanced so each message is handled
 * exactly once across runs.
 *
 * Modes:
 *   --once            single check, return immediately (timeout 0). No lock.
 *   --wait <sec>      long-poll: block up to <sec> for the next message, but
 *                     RETURN EARLY the instant a message arrives. <sec> may
 *                     exceed Telegram's 50s cap — it's chunked.
 *   --lock            manage the session lock (use with --wait). See below.
 *   --owner <id>      lock owner id for this run (required with --lock). The
 *                     scheduled task picks ONE id per run and passes it to every
 *                     poll/lock call, so a run never yields to itself.
 *   --no-persist      don't advance the offset (peek only; for testing).
 *
 * Lock lifecycle (the heartbeat model — see telegram.mjs):
 *   A run owns the lock for its WHOLE lifetime, not just one listen window.
 *   - On acquire failure (another run holds it fresh): print {"locked":true}.
 *   - While listening: the lock is refreshed each long-poll chunk.
 *   - When MESSAGES are returned: the lock is HELD (refreshed, NOT released) so
 *     it stays owned through the processing/reply that follows. The agent keeps
 *     it warm with `telegram-lock.mjs guard/refresh` during heavy work and
 *     RELEASES it explicitly (`telegram-lock.mjs release`) when the chat goes
 *     cold.
 *   - When the wait returns EMPTY (conversation cold, run ending): the lock is
 *     released here automatically.
 *
 * Output (stdout, JSON):
 *   {"locked":true,...}                     another run holds the lock → yield
 *   {"messages":[ {updateId,chatId,from,date,text,media}, ... ]}
 *     media is null for plain text, else
 *     {kind,fileId,fileUniqueId,fileName,mimeType,fileSize,localPath}.
 *     Attached files (photos/documents you send) are downloaded to the inbox
 *     folder (TELEGRAM_INBOX_DIR, default inbox/) and localPath points at the
 *     saved file so the agent can read it. text carries the message text OR a
 *     file's caption.
 */

import {
  loadDotEnv, pollUpdates, logBridge,
  acquireLock, refreshLock, releaseLock,
} from './telegram.mjs';

loadDotEnv();

const argv = process.argv.slice(2);
let mode = 'once';
let waitSec = 50;
let persist = true;
let useLock = false;
let owner = '';
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--once') mode = 'once';
  else if (argv[i] === '--wait') { mode = 'wait'; const n = parseInt(argv[i + 1], 10); if (Number.isFinite(n)) { waitSec = n; i++; } }
  else if (argv[i] === '--no-persist') persist = false;
  else if (argv[i] === '--lock') useLock = true;
  else if (argv[i] === '--owner') owner = String(argv[++i] || '');
}
if (useLock && !owner) owner = `anon-${Date.now()}`; // fallback so a stray call still works

async function main() {
  logBridge('LISTEN.start', `mode=${mode}${mode === 'wait' ? ` wait=${waitSec}s` : ''} lock=${useLock ? `on owner=${owner}` : 'off'}`);

  if (mode === 'once') {
    const messages = await pollUpdates({ persist, timeout: 0 });
    logBridge('LISTEN.end', `once → ${messages.length} message(s)`);
    process.stdout.write(JSON.stringify({ messages }) + '\n');
    return;
  }

  // --wait
  if (useLock) {
    const lock = acquireLock(owner);
    if (!lock.ok) {
      logBridge('LOCK.busy', `held by ${lock.owner} (age=${lock.age}s) → yielding`);
      process.stdout.write(JSON.stringify({ locked: true, owner: lock.owner, age: lock.age }) + '\n');
      return;
    }
    logBridge('LOCK.acquired', `owner=${owner}`);
  }

  // chunk into <=50s Telegram long-polls, return on first message(s)
  const deadline = Date.now() + waitSec * 1000;
  let messages = [];
  do {
    if (useLock) refreshLock(owner); // heartbeat while listening
    const remaining = Math.ceil((deadline - Date.now()) / 1000);
    const chunk = Math.max(1, Math.min(50, remaining));
    logBridge('POLL.chunk', `long-poll ${chunk}s (≈${remaining}s left of ${waitSec}s)`);
    messages = await pollUpdates({ persist, timeout: chunk });
    if (messages.length) break;
  } while (Date.now() < deadline);

  if (useLock) {
    if (messages.length) {
      refreshLock(owner); // HOLD through processing — agent releases when cold
      logBridge('LISTEN.end', `${messages.length} message(s) — lock HELD (owner=${owner})`);
    } else {
      releaseLock(owner); // cold / run ending — free the lock for the next tick
      logBridge('LISTEN.end', `empty after ${waitSec}s wait`);
      logBridge('LOCK.released', `owner=${owner} (cold)`);
    }
  } else {
    logBridge('LISTEN.end', messages.length ? `${messages.length} message(s)` : `empty after ${waitSec}s wait`);
  }
  process.stdout.write(JSON.stringify({ messages }) + '\n');
}

main().catch((e) => {
  process.stderr.write('poll failed: ' + e.message + '\n');
  process.exit(1);
});
