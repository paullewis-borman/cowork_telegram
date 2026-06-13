#!/usr/bin/env node
/**
 * telegram-context.mjs — rolling conversation memory for the bridge.
 *
 * A scheduled run has NO memory of previous runs: the poll only fetches NEW
 * messages since the stored offset, so the conversational thread is lost
 * between runs. This helper preserves a little continuity by keeping a small
 * rolling log of run summaries:
 *
 *   • At the START of a run, read the recent entries to recover the thread.
 *   • At the END of a run, append a short dated summary of what happened.
 *
 * Entries are newest-first and capped to the most recent MAX_ENTRIES so the
 * file never bloats. It is LOCAL-ONLY runtime state (gitignored like the
 * offset/lock files) — it lives next to .env at REPO_ROOT and is never
 * committed or deployed. Only this script + the AGENTS.md lifecycle are shared
 * across projects.
 *
 * Commands:
 *   read [--entries N]              Print the log (or its most recent N entries)
 *                                   to stdout. Empty (exit 0) if no log yet.
 *   append --text "<summary>"       Prepend a dated entry. Summary may also be
 *   append            (via stdin)   piped in on stdin instead of --text.
 *
 * Env:
 *   TELEGRAM_CONTEXT_MAX_ENTRIES    Cap on retained entries (default 30).
 *   TELEGRAM_CONTEXT_FILE           Override the file path (default
 *                                   telegram-context.md at REPO_ROOT).
 *
 * Examples:
 *   node telegram-context.mjs read --entries 8
 *   node telegram-context.mjs append --text "Discussed context-log idea; built it."
 *   printf '%s' "$SUMMARY" | node telegram-context.mjs append
 */

import fs from 'fs';
import path from 'path';
import { REPO_ROOT, logBridge } from './telegram.mjs';

const CONTEXT_FILE = process.env.TELEGRAM_CONTEXT_FILE
  ? path.resolve(process.env.TELEGRAM_CONTEXT_FILE)
  : path.join(REPO_ROOT, 'telegram-context.md');

const MAX_ENTRIES = Math.max(1, Number(process.env.TELEGRAM_CONTEXT_MAX_ENTRIES) || 30);

const TITLE = '# Telegram bridge — conversation memory';
const NOTE =
  '<!-- Rolling, newest-first log of run summaries. Local-only (gitignored). ' +
  'Read the top entries at the start of a run to recover the thread; append one ' +
  `at the end. Auto-trimmed to the most recent ${MAX_ENTRIES} entries. -->`;

const argv = process.argv.slice(2);
const cmd = argv[0];

function flag(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** Split the file body into entry blocks (each begins with "## "), newest-first. */
function readEntries() {
  let raw = '';
  try { raw = fs.readFileSync(CONTEXT_FILE, 'utf8'); } catch { return []; }
  const blocks = raw.split(/\n(?=## )/).map((b) => b.trim()).filter(Boolean);
  // The first block holds the title/note preamble, not an entry — drop it.
  return blocks.filter((b) => b.startsWith('## '));
}

function writeEntries(entries) {
  const kept = entries.slice(0, MAX_ENTRIES);
  const body = [`${TITLE}\n\n${NOTE}`, ...kept].join('\n\n') + '\n';
  fs.writeFileSync(CONTEXT_FILE, body);
  return kept.length;
}

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

if (cmd === 'read') {
  const n = Number(flag('--entries'));
  const entries = readEntries();
  if (!entries.length) { process.exit(0); }
  const slice = Number.isFinite(n) && n > 0 ? entries.slice(0, n) : entries;
  process.stdout.write(`${TITLE}\n\n` + slice.join('\n\n') + '\n');
} else if (cmd === 'append') {
  let text = flag('--text');
  if (text === undefined) text = readStdin();
  text = String(text || '').trim();
  if (!text) { process.stderr.write('append needs --text "<summary>" or stdin\n'); process.exit(2); }
  const stamp = new Date().toISOString();
  const entry = `## ${stamp}\n${text}`;
  const kept = writeEntries([entry, ...readEntries()]);
  logBridge('CONTEXT.append', `entries=${kept} (cap ${MAX_ENTRIES})`);
  process.stdout.write(JSON.stringify({ appended: true, entries: kept, file: CONTEXT_FILE }) + '\n');
} else {
  process.stderr.write('usage: telegram-context.mjs <read [--entries N] | append [--text "..."]>\n');
  process.exit(2);
}
