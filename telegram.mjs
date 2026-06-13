/**
 * telegram.mjs — shared helpers for a two-way Cowork ⇄ Telegram bridge.
 *
 * A small, dependency-free bridge that lets a Cowork (Claude) agent talk to you
 * over Telegram and act on your replies:
 *   • Claude → you  : sendMessage()   (used by telegram-send.mjs)
 *   • you → Claude  : pollUpdates()   (used by telegram-poll.mjs, run by your
 *                                      scheduled "telegram-poll" task)
 *
 * Drop these four files into any project (at the repo root, or set
 * TELEGRAM_BRIDGE_ROOT — see below) and you have a reusable bridge.
 *
 * Config (from .env in the bridge root, gitignored — never committed):
 *   TELEGRAM_BOT_TOKEN   BotFather token, e.g. 123456:ABC-DEF...
 *   TELEGRAM_CHAT_ID     Your chat id (captured on first run). Used as the
 *                        default send target AND as an allow-list so the bot
 *                        only ever acts on YOUR messages.
 *
 * Optional:
 *   TELEGRAM_BRIDGE_ROOT  Absolute path to the folder that holds .env and the
 *                         local runtime state files (offset, lock, log). Defaults
 *                         to the directory these scripts live in. Set it if you
 *                         embed the scripts in a subfolder (e.g. backend/scripts)
 *                         but want state to live at your project root.
 *
 * No external deps: Node 18+ global fetch + a tiny .env parser. The polling
 * offset is persisted to .telegram-offset.json in the bridge root (gitignored,
 * local-only) so messages are processed exactly once across runs.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Where .env and local runtime state (offset, lock, log) live. Defaults to the
// scripts' own directory so the repo works standalone with zero config. Override
// with TELEGRAM_BRIDGE_ROOT when embedding the scripts in a host project.
export const REPO_ROOT = process.env.TELEGRAM_BRIDGE_ROOT
  ? path.resolve(process.env.TELEGRAM_BRIDGE_ROOT)
  : __dirname;

const OFFSET_FILE = path.join(REPO_ROOT, '.telegram-offset.json');

// ---- debug log ------------------------------------------------------------
// Human-readable trace of every bridge action — messages sent/received, listen
// cycles, lock state and backoff waits — so responsiveness can be debugged.
// Local-only: telegram-bridge.log is gitignored via *.log (never deployed).
export const BRIDGE_LOG = path.join(REPO_ROOT, 'telegram-bridge.log');

/** Append one timestamped line. Never throws — logging must not break the bridge. */
export function logBridge(ev, detail = '') {
  const line = `[${new Date().toISOString()}] pid=${process.pid} ${ev}${detail ? ' — ' + detail : ''}\n`;
  try { fs.appendFileSync(BRIDGE_LOG, line); } catch { /* best effort */ }
}

/** One-line, single-spaced preview of a message body for the log. */
export function preview(text, n = 200) {
  const s = String(text).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// ---- session lock (owner-token, heartbeat, no deletes) --------------------
// One run owns the lock for its WHOLE lifetime: listen → process → listen …
// → cold → release. A concurrent cron tick that finds a fresh lock owned by a
// DIFFERENT run yields entirely (it never even listens), so there's no overlap
// during the minutes a run spends doing repo-mutating work.
//
// Why owner tokens: each scheduled run makes many independent shell calls in
// fresh sandboxes (pids reset, no shared memory). The only durable handle is
// this file + the owner string the agent threads through every call. A run
// picks one owner id at start and passes `--owner <id>` to every poll/lock
// call, so its own later calls refresh (not yield to) its lock.
//
// Why a 5-min TTL: it's the crash-safety net only. While a run is alive the
// heartbeat (poll chunks + `telegram-lock.mjs guard`/`refresh`) keeps the lock
// fresh well within the TTL; the TTL just auto-frees the lock if a run dies
// holding it. Never delete the lock file — on some sandboxed/mounted filesystems
// deletes are permission-gated; release WRITES a `released:true` marker instead.
export const LOCK_FILE = path.join(REPO_ROOT, '.telegram-session.lock');
export const LOCK_TTL_MS = 300_000; // 5 min crash-safety net

export function lockState() {
  try { return JSON.parse(fs.readFileSync(LOCK_FILE, 'utf-8')); } catch { return null; }
}

function writeLock(owner, released) {
  try {
    fs.writeFileSync(LOCK_FILE, JSON.stringify({ owner, at: new Date().toISOString(), released }));
  } catch { /* best effort — logging/locking must never break the bridge */ }
}

/**
 * Acquire the lock for `owner`. Succeeds if the lock is free, released, stale
 * (older than the TTL), or already owned by `owner`. Fails only if a DIFFERENT
 * run holds it fresh.
 * @returns {{ok:true}|{ok:false,age:number,owner:string}}
 */
export function acquireLock(owner) {
  const s = lockState();
  if (s && !s.released && s.owner !== owner) {
    const age = Date.now() - new Date(s.at).getTime();
    if (age < LOCK_TTL_MS) return { ok: false, age: Math.round(age / 1000), owner: s.owner };
  }
  writeLock(owner, false);
  return { ok: true };
}

/** Heartbeat: stamp the lock fresh for `owner` (held). */
export function refreshLock(owner) { writeLock(owner, false); }

/** Release: write a released marker for `owner` (a write, never a delete). */
export function releaseLock(owner) { writeLock(owner, true); }

// ---- env ------------------------------------------------------------------

export function loadDotEnv(paths = [path.join(REPO_ROOT, '.env')]) {
  for (const p of paths) {
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf-8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (!m) continue;
      const k = m[1];
      const v = m[2].trim().replace(/^["']|["']$/g, '');
      if (process.env[k] === undefined) process.env[k] = v;
    }
  }
}

export function getToken() {
  const t = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
  if (!t) throw new Error('TELEGRAM_BOT_TOKEN is not set in .env');
  return t;
}

export function getChatId() {
  return (process.env.TELEGRAM_CHAT_ID || '').trim();
}

// ---- low-level API --------------------------------------------------------

async function api(method, params = {}, { fetchTimeoutMs = 20000 } = {}) {
  const token = getToken();
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), fetchTimeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: ac.signal,
    });
  } finally {
    clearTimeout(t);
  }
  const data = await res.json().catch(() => ({}));
  if (!data.ok) {
    throw new Error(`Telegram ${method} failed: ${data.error_code || res.status} ${data.description || ''}`.trim());
  }
  return data.result;
}

/** Verify the token. Returns the bot's info ({ id, username, ... }). */
export function getMe() {
  return api('getMe');
}

// ---- inbound media (you → Claude: photos, documents, …) -------------------
// Files you send are downloaded to an "inbox" folder so the agent can read them.
// The folder is configurable via TELEGRAM_INBOX_DIR (.env) — a path relative to
// the bridge root, or absolute. Defaults to `inbox/`. Resolved lazily (not at
// import) because .env is loaded by the CLIs after this module is imported.

/** Absolute path of the inbox folder where inbound files are saved. */
export function getInboxDir() {
  const configured = (process.env.TELEGRAM_INBOX_DIR || '').trim() || 'inbox';
  return path.isAbsolute(configured) ? configured : path.join(REPO_ROOT, configured);
}

/**
 * Resolve a Telegram file_id to a downloadable path on Telegram's file server.
 * @returns {Promise<{file_id,file_unique_id,file_size,file_path}>}
 */
export function getFile(fileId) {
  return api('getFile', { file_id: fileId });
}

/** Make a filename safe for the local fs (no slashes / control chars). */
function safeName(name) {
  return String(name || 'file').replace(/[^\w.\-]+/g, '_').slice(0, 120) || 'file';
}

/**
 * Download a Telegram file to the inbox folder and return the absolute local
 * path. Telegram serves files at
 * https://api.telegram.org/file/bot<token>/<file_path>.
 * @param {object} m  a media descriptor from pollUpdates ({ fileId, fileName, kind, fileUniqueId })
 * @returns {Promise<string>} absolute local path of the saved file
 */
export async function downloadMediaItem(m, { timeoutMs = 60000 } = {}) {
  const token = getToken();
  const info = await getFile(m.fileId);            // { file_path, ... }
  const remotePath = info.file_path;               // e.g. 'photos/file_3.jpg'
  if (!remotePath) throw new Error('getFile returned no file_path');
  const ext = path.extname(remotePath) || path.extname(m.fileName || '') || '';
  const base = m.fileName ? safeName(m.fileName) : `${m.kind}${ext || ''}`;
  const inboxDir = getInboxDir();
  const dest = path.join(inboxDir, `${m.fileUniqueId}-${safeName(base)}`);

  const url = `https://api.telegram.org/file/bot${token}/${remotePath}`;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
  if (!res.ok) throw new Error(`file download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  try { fs.mkdirSync(inboxDir, { recursive: true }); } catch { /* exists */ }
  fs.writeFileSync(dest, buf);
  return dest;
}

/**
 * Pull a normalised media descriptor out of a Telegram message, or null if it
 * carries no file. Photos arrive as an array of sizes — we take the largest.
 * @returns {{kind,fileId,fileUniqueId,fileName,mimeType,fileSize}|null}
 */
export function extractMedia(msg) {
  if (msg.photo && msg.photo.length) {
    const largest = msg.photo[msg.photo.length - 1]; // sizes are ascending
    return {
      kind: 'photo',
      fileId: largest.file_id,
      fileUniqueId: largest.file_unique_id,
      fileName: `photo-${largest.file_unique_id}.jpg`,
      mimeType: 'image/jpeg',
      fileSize: largest.file_size,
    };
  }
  const map = { document: 'document', audio: 'audio', voice: 'voice', video: 'video', video_note: 'video_note', animation: 'animation', sticker: 'sticker' };
  for (const [field, kind] of Object.entries(map)) {
    const f = msg[field];
    if (f && f.file_id) {
      return {
        kind,
        fileId: f.file_id,
        fileUniqueId: f.file_unique_id,
        fileName: f.file_name || `${kind}-${f.file_unique_id}`,
        mimeType: f.mime_type || null,
        fileSize: f.file_size,
      };
    }
  }
  return null;
}

/**
 * Send a message to you (or an explicit chatId).
 * Telegram caps messages at 4096 chars; we split on that boundary.
 */
export async function sendMessage(text, opts = {}) {
  const chatId = opts.chatId || getChatId();
  if (!chatId) throw new Error('No chat id: set TELEGRAM_CHAT_ID in .env or pass { chatId }');
  const parseMode = opts.parseMode === undefined ? 'Markdown' : opts.parseMode; // null disables
  const full = String(text);
  const chunks = chunk(full, 4096);
  const results = [];
  try {
    for (const c of chunks) {
      const params = { chat_id: chatId, text: c, disable_web_page_preview: true };
      if (parseMode) params.parse_mode = parseMode;
      try {
        results.push(await api('sendMessage', params));
      } catch (e) {
        // Markdown parse errors are common with arbitrary text — retry as plain.
        if (parseMode && /can't parse entities|parse/i.test(e.message)) {
          results.push(await api('sendMessage', { chat_id: chatId, text: c, disable_web_page_preview: true }));
        } else {
          throw e;
        }
      }
    }
  } catch (e) {
    logBridge('SEND.fail', `chat=${chatId} len=${full.length} err="${e.message}"`);
    throw e;
  }
  logBridge('SEND', `chat=${chatId} len=${full.length} chunks=${chunks.length} → "${preview(full)}"`);
  return results;
}

// ---- offset persistence ---------------------------------------------------

function readOffset() {
  try {
    return JSON.parse(fs.readFileSync(OFFSET_FILE, 'utf-8')).offset || 0;
  } catch {
    return 0;
  }
}

function writeOffset(offset) {
  fs.writeFileSync(OFFSET_FILE, JSON.stringify({ offset, updatedAt: new Date().toISOString() }, null, 2));
}

/**
 * Fetch new messages since the last processed update, advance the stored
 * offset, and return a normalised list. Only messages from TELEGRAM_CHAT_ID
 * are returned (if set) — the bot ignores everyone else.
 *
 * Messages may carry text, media (a photo/document/etc.), or both (a file with
 * a caption). When `downloadMedia` is true (default), any attached file is
 * downloaded to the inbox folder (see getInboxDir) and its absolute local path
 * is set on `media.localPath` so the agent can read it straight away.
 *
 * @returns {Promise<Array<{updateId,chatId,from,date,text,media}>>}
 */
export async function pollUpdates({ persist = true, timeout = 0, downloadMedia = true } = {}) {
  const offset = readOffset();
  const updates = await api('getUpdates', {
    offset: offset ? offset + 1 : undefined,
    timeout, // server-side long-poll: blocks up to `timeout` sec for a new update
    allowed_updates: ['message'],
  }, { fetchTimeoutMs: (timeout + 15) * 1000 });

  const allow = getChatId();
  let maxId = offset;
  const messages = [];
  for (const u of updates) {
    if (u.update_id > maxId) maxId = u.update_id;
    const msg = u.message;
    if (!msg) continue;
    const chatId = String(msg.chat?.id ?? '');
    if (allow && chatId !== allow) continue; // ignore non-allow-listed chats

    const media = extractMedia(msg);
    const text = msg.text || msg.caption || '';
    if (!text && !media) continue; // nothing actionable (e.g. service message)

    messages.push({
      updateId: u.update_id,
      chatId,
      from: msg.from?.username || msg.from?.first_name || chatId,
      date: new Date((msg.date || 0) * 1000).toISOString(),
      text,
      media: media || null,
    });
  }

  // Download attached files (best-effort: a download failure must not drop the
  // message — the agent still gets the text/caption and the media metadata).
  if (downloadMedia) {
    for (const m of messages) {
      if (!m.media) continue;
      try {
        m.media.localPath = await downloadMediaItem(m.media);
      } catch (e) {
        m.media.localPath = null;
        m.media.downloadError = e.message;
        logBridge('MEDIA.fail', `id=${m.updateId} kind=${m.media.kind} err="${e.message}"`);
      }
    }
  }

  if (persist && maxId !== offset) writeOffset(maxId);
  if (messages.length) {
    for (const m of messages) {
      const tag = m.media ? ` [${m.media.kind}${m.media.localPath ? ' ✓' : ''}]` : '';
      logBridge('RECV', `from=${m.from} id=${m.updateId}${tag} → "${preview(m.text || '(no caption)')}"`);
    }
  }
  return messages;
}

// ---- util -----------------------------------------------------------------

function chunk(s, n) {
  if (s.length <= n) return [s];
  const out = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
}
