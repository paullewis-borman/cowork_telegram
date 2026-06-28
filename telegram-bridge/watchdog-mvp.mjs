#!/usr/bin/env node
/**
 * watchdog-mvp.mjs — PROTOTYPE, not part of the AGENTS.md contract.
 *
 * Tests the idea: a single always-on Node process long-polls Telegram (near-zero
 * cost, no LLM involved) and only spawns `claude -p` when a real message
 * arrives. No Cowork scheduled task, no 5-minute cron, no lock file needed
 * (one continuous process — no concurrent runs to coordinate).
 *
 * Run it in the FOREGROUND for now, in a terminal on the Mac (not inside the
 * Cowork sandbox — it needs the Mac's own `claude` install + login):
 *
 *   cd telegram-bridge
 *   WATCHDOG_PROJECT_DIR="/Users/plb/Documents/NewRepo/Schvitz/Schvitz Website" \
 *     node watchdog-mvp.mjs
 *
 * ⚠️ Before running: pause the `schvitz-telegram-poll` Cowork scheduled task.
 * Telegram's getUpdates offset is global per bot — two pollers on the same bot
 * will steal each other's messages. See MVP-TEST-PLAN.md.
 *
 * Env vars (all optional, set in .env or inline):
 *   WATCHDOG_PROJECT_DIR        cwd for `claude -p` (so it sees that project's
 *                                CLAUDE.md, git repo, etc). Defaults to cwd.
 *   WATCHDOG_CLAUDE_BIN          path to the claude binary. Default: "claude".
 *   WATCHDOG_ALLOWED_TOOLS       --allowedTools value. Default:
 *                                "Read,Glob,Grep,Bash,Edit,Write".
 *   WATCHDOG_CLAUDE_TIMEOUT_MS   kill claude -p if it runs longer than this.
 *                                Default: 240000 (4 min).
 *   WATCHDOG_IDLE_RESET_MIN      if the last exchange was longer ago than this
 *                                many minutes, start a fresh session instead of
 *                                --resume (avoids resuming a stale/huge
 *                                context). Default: 360 (6h).
 *
 * Media (added 2026-06-28):
 *   - Inbound: pollUpdates() already downloads photos/documents to the inbox
 *     folder (see telegram.mjs) and sets media.localPath — this script now
 *     passes that path to claude -p instead of ignoring it, and no longer
 *     skips captionless attachments.
 *   - Outbound: there's no structured "attachment" return value from
 *     `claude -p`, so sending a file back is done by the spawned Claude
 *     itself: the prompt tells it it can run
 *     `node "<this-folder>/telegram-send.mjs" --file <path>` via Bash. The
 *     watchdog's own final sendMessage() call still only ever relays text.
 *
 * What this does NOT do yet (deliberately, for the MVP):
 *   - No multi-bot/multi-project routing — one watchdog per bot, same as the
 *     existing Cowork-task convention.
 *
 * Supervision: not yet generalised into a copy-paste template in this repo.
 * For a working example, see the Schvitz project's
 * com.schvitz.telegram-watchdog.plist — it follows the same pattern as
 * gitbroker's own launchd service (absolute node/claude paths, logs to
 * ~/Library/Logs, KeepAlive + RunAtLoad). Adapt its paths per-project.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  loadDotEnv, pollUpdates, sendMessage, logBridge, REPO_ROOT,
} from './telegram.mjs';

loadDotEnv();

const BRIDGE_DIR = path.dirname(fileURLToPath(import.meta.url));
const SEND_SCRIPT = path.join(BRIDGE_DIR, 'telegram-send.mjs');
const PROJECT_DIR = process.env.WATCHDOG_PROJECT_DIR
  ? path.resolve(process.env.WATCHDOG_PROJECT_DIR)
  : process.cwd();
const SESSION_FILE = path.join(REPO_ROOT, '.watchdog-session.json');
const IDLE_RESET_MIN = parseInt(process.env.WATCHDOG_IDLE_RESET_MIN || '360', 10);
const CLAUDE_BIN = process.env.WATCHDOG_CLAUDE_BIN || 'claude';
const ALLOWED_TOOLS = process.env.WATCHDOG_ALLOWED_TOOLS || 'Read,Glob,Grep,Bash,Edit,Write';
const CLAUDE_TIMEOUT_MS = parseInt(process.env.WATCHDOG_CLAUDE_TIMEOUT_MS || '240000', 10);

function readSession() {
  try {
    const s = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
    if (s.sessionId && s.lastActivity) {
      const idleMin = (Date.now() - new Date(s.lastActivity).getTime()) / 60000;
      if (idleMin > IDLE_RESET_MIN) {
        console.log(`[watchdog] last exchange ${idleMin.toFixed(0)}min ago > ${IDLE_RESET_MIN}min — starting fresh session`);
        return { sessionId: null };
      }
    }
    return s;
  } catch {
    return { sessionId: null };
  }
}

function writeSession(sessionId) {
  fs.writeFileSync(
    SESSION_FILE,
    JSON.stringify({ sessionId, lastActivity: new Date().toISOString() }, null, 2),
  );
}

function runClaude(prompt, sessionId) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p', prompt,
      '--output-format', 'json',
      '--permission-mode', 'acceptEdits',
      '--allowedTools', ALLOWED_TOOLS,
    ];
    if (sessionId) args.push('--resume', sessionId);

    console.log(`[watchdog] spawning claude -p (resume=${sessionId || 'none'}) in ${PROJECT_DIR}`);
    const child = spawn(CLAUDE_BIN, args, { cwd: PROJECT_DIR, env: process.env });

    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`claude -p timed out after ${CLAUDE_TIMEOUT_MS}ms`));
    }, CLAUDE_TIMEOUT_MS);

    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`claude -p exited ${code}: ${err.trim().slice(0, 500) || '(no stderr)'}`));
        return;
      }
      try {
        resolve(JSON.parse(out));
      } catch (e) {
        reject(new Error(`could not parse claude -p output as JSON: ${e.message}\nraw: ${out.slice(0, 500)}`));
      }
    });
  });
}

/**
 * Build the actual `claude -p` prompt from a poll message: a short bridge
 * capability note (always, so a resumed session is reminded every turn),
 * an inbound-media note if this message carried a file, then the user's
 * own text (or a placeholder if it was a captionless attachment).
 */
function buildPrompt(msg) {
  const parts = [
    `[Telegram bridge: to send a photo or file back to the user, run ` +
    `node "${SEND_SCRIPT}" --file <path> [--caption "..."] via Bash — ` +
    `images send inline automatically, anything else as a document.]`,
  ];
  if (msg.media) {
    const m = msg.media;
    const where = m.localPath
      ? `downloaded to ${m.localPath}`
      : `(download failed: ${m.downloadError || 'unknown error'})`;
    parts.push(
      `[User sent a ${m.kind}${m.fileName ? ` ("${m.fileName}")` : ''}` +
      `${m.mimeType ? `, ${m.mimeType}` : ''} — ${where}]`,
    );
  }
  parts.push(msg.text || (msg.media ? '(no caption — see attached file above)' : ''));
  return parts.join('\n');
}

async function handleMessage(msg) {
  const session = readSession();
  const prompt = buildPrompt(msg);
  const logText = msg.text || (msg.media ? `(${msg.media.kind}, no caption)` : '(empty)');
  console.log(`[watchdog] <- "${logText}" (resume=${session.sessionId || 'none, fresh session'})`);
  try {
    const result = await runClaude(prompt, session.sessionId);
    writeSession(result.session_id);
    const cost = result.total_cost_usd != null ? ` ($${Number(result.total_cost_usd).toFixed(4)})` : '';
    console.log(`[watchdog] -> "${(result.result || '').slice(0, 200)}"${cost}`);
    logBridge('WATCHDOG.reply', `session=${result.session_id} cost=${result.total_cost_usd ?? 'n/a'}`);
    await sendMessage(result.result || '(claude returned no result text)');
  } catch (e) {
    console.error('[watchdog] claude -p failed:', e.message);
    logBridge('WATCHDOG.error', e.message);
    await sendMessage(`watchdog-mvp error: ${e.message}`.slice(0, 1000));
  }
}

async function main() {
  console.log(`[watchdog] PROTOTYPE watcher starting. project dir = ${PROJECT_DIR}`);
  console.log('[watchdog] make sure the schvitz-telegram-poll Cowork scheduled task is PAUSED — two pollers on one bot steal each other\'s updates.');
  console.log('[watchdog] Ctrl+C to stop.');
  for (;;) {
    let messages = [];
    try {
      messages = await pollUpdates({ persist: true, timeout: 30 });
    } catch (e) {
      console.error('[watchdog] poll failed, retrying in 5s:', e.message);
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    for (const m of messages) {
      if (m.text || m.media) {
        await handleMessage(m);
      } else {
        console.log('[watchdog] skipping message with neither text nor media (e.g. a service message)');
      }
    }
  }
}

main();
