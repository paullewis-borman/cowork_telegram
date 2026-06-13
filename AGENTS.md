# AGENTS.md — operating the Telegram bridge

**📍 This is the `cowork_telegram` repo's AGENTS.md** — read it when running the two-way Telegram bridge. Not to be confused with `gitbroker/AGENTS.md` (the git publish broker).

This file tells a **Cowork/Claude agent** how to run the two-way Telegram bridge
in a scheduled task. It assumes a human has already done the one-time setup in
[README.md](./README.md) (bot token, chat id, `.env`). If `.env` has no
`TELEGRAM_BOT_TOKEN` or an empty `TELEGRAM_CHAT_ID`, the bridge isn't configured
— exit quietly and do nothing.

> **Portability:** a host project should not duplicate this contract. Point its
> own project memory (e.g. `CLAUDE.md`) at this file with a single line —
> *"Telegram bridge → see `cowork_telegram/AGENTS.md`"* — and keep only
> project-specific facts (the scheduled-task name, where the scripts are
> embedded) locally.

All commands assume you run from the bridge root (where `.env` lives). If the
scripts are embedded in a subfolder (e.g. `backend/scripts/`), prefix the path
accordingly and set `TELEGRAM_BRIDGE_ROOT` so state files resolve to the project
root.

## First: which scenario are you in? (setup vs. running)

If this project already has a working `.env` (with `TELEGRAM_BOT_TOKEN` **and**
`TELEGRAM_CHAT_ID`) and the scripts are present, it's set up — go straight to
*The run lifecycle*. Otherwise you're wiring it in. Confirm with
`node telegram-poll.mjs --once --no-persist`: an unset-token / empty-chat-id
error means it isn't configured yet. Two cases — detect which **before** acting:

**Scenario A — you've used this bridge on this machine before** (another project
already runs a bot). The *code* is known and your Telegram account (the chat id)
already exists; only this project is new.

> ⚠️ **One bot ≠ many projects.** Telegram's `getUpdates` offset is **per-bot and
> global** — two pollers sharing one bot token will steal each other's messages
> unpredictably. So **each project gets its own bot.** "Already installed" saves
> you the learning curve, not the bot.

→ Steps: (1) create a **new** bot in [@BotFather](https://t.me/BotFather)
(`/newbot`) for this project; (2) copy the four `.mjs` scripts into this repo
(set `TELEGRAM_BRIDGE_ROOT` if you embed them in a subfolder); (3) put the **new
token** plus your **existing chat id** in this project's `.env`; (4) create the
scheduled poll task. Reuse the chat id (it's just *you*); never reuse the token.

**Scenario B — fresh install on this machine** (no bridge anywhere yet). →
Follow the README *Setup*: create a bot with BotFather, then capture your chat id
with `node telegram-poll.mjs --once`. Then create the scheduled task.

## Scheduled-task setup template

Both scenarios end with "create the scheduled task." Here is a ready-to-paste
template — create one **per project**, on a `*/5 * * * *` (every-5-min) cron,
which is the floor; the adaptive cadence keeps it hot while you're chatting and
backs off when quiet. Fill the three `<…>` placeholders and paste the body as
the task prompt:

```
You are the <PROJECT NAME> Telegram bridge — the two-way link between me and
Cowork over Telegram. Each run, listen for my messages, act on them, and reply
to me on Telegram. You have no memory of previous runs.

Follow cowork_telegram/AGENTS.md exactly as the operating contract: read the
conversation memory to recover the thread, pick a run owner id, do the config
check, then run the lock-based listen → handle → reply → adaptive-cadence loop.
When the chat goes cold, append a short memory summary, release the lock, and
write one task-log line. Wrap any long or repo-mutating step in
`telegram-lock.mjs guard`.

Project-specific facts:
- Scripts live in: <PATH TO SCRIPTS, e.g. backend/scripts/ — else repo root>
  (if embedded in a subfolder, set TELEGRAM_BRIDGE_ROOT to the repo root so
  state files resolve there, and prefix script paths accordingly).
- .env (with TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID) lives at the repo root.
- Task log to append one line per run: <PATH TO TASK LOG, e.g. scheduled-task.log>
```

Notes: each project needs its **own** bot token (one bot ≠ many projects — see
Scenario A); the chat id is just *you* and is reused. If `.env` is unconfigured
the run exits quietly, so an enabled task is harmless before setup is finished.

## The run lifecycle

Each scheduled run is stateless — it listens for new messages, acts on them,
replies, and ends when the chat goes cold. There is no memory between runs; the
offset file guarantees each message is handled exactly once. To carry a *little*
continuity across runs there is a rolling conversation memory — read it at the
start, append to it at the end (see *Conversation memory* below).

### 0. Recover the thread (conversation memory)

Before doing anything else, read the recent run summaries so you don't restart
cold mid-conversation:

```bash
node telegram-context.mjs read --entries 8
```

It prints the most recent entries (or nothing if there's no log yet). Use it to
recover what you and the owner were last discussing.

### 1. Pick a run owner id (once, at the start)

```bash
date +run-%s%N    # use this exact string as <OWNER> on EVERY poll/lock call below
```

The owner id is how the lock knows your own later calls are *you* (so you never
yield to yourself) and how a concurrent run knows to stand down.

### 2. Listen (acquires/holds the session lock)

```bash
node telegram-poll.mjs --wait 50 --lock --owner <OWNER>
```

- `{"locked":true,...}` → **another run owns the lock → STOP immediately.** Do
  nothing else, don't message, don't release (it isn't yours).
- `{"messages":[...]}` (non-empty) → the lock is now **HELD by you**; handle the
  messages (below), reply, then continue in HOT MODE.
- `{"messages":[]}` → cold; the lock was auto-released. Nothing happened this
  run, so there's nothing to remember — just run
  `node telegram-lock.mjs release --owner <OWNER>` and **end the run** (the cron
  floor will check again next tick).

### 3. HOT MODE (snappy while chatting, back off when quiet)

Back-off wait seconds `[30, 60, 120, 240, 300]`, starting at 30:
- Listen `--wait <current> --lock --owner <OWNER>`.
- Messages → handle + reply, **reset** the index to 30.
- Empty → advance one step.
- A `--wait 300` that returns empty (~5 min silence) → **append a one-line memory
  summary** of this run (see *Conversation memory*), then `release --owner
  <OWNER>` and END the run.
- `{"locked":true}` at any point → STOP (don't release).

### 4. Keep the lock warm during heavy work

For any command that may take >20s (git add/commit/push, file/image generation,
long jobs), wrap it so the lock keeps heartbeating:

```bash
node telegram-lock.mjs guard --owner <OWNER> -- <your command>
```

The lock auto-expires after 5 min only as a crash-safety net, so don't go silent
longer than that mid-job. `refresh` / `release` / `status` subcommands exist too.

### 5. Reply

```bash
printf '%s' "your reply text" | node telegram-send.mjs   # Markdown; --plain for literal
```

Always reply to every message — at minimum acknowledge receipt, and send a final
result when done. Keep replies short and mobile-friendly.

**Sending a file back (photo or document).** When the owner asks for a file —
"send me that PDF / the chart / a screenshot" — don't paste a wall of text or a
raw path; upload the file with `--file`:

```bash
node telegram-send.mjs --file ./report.pdf --caption "this quarter's numbers"
node telegram-send.mjs --file ./chart.png                      # auto-sent as a photo
node telegram-send.mjs --file ./logo.png --document            # force lossless document
```

Routing: image types (`.jpg/.jpeg/.png/.webp/.gif`) go as a **photo** (shown
inline, but Telegram re-compresses them); everything else goes as a
**document** (exact bytes preserved). Force either way with `--photo` /
`--document` (alias `--as photo|document`). `--caption` adds a caption (Markdown,
or `--plain` for literal); the caption can also come from a positional arg or
stdin. Telegram caps bot uploads at **50 MB**. Programmatically, `telegram.mjs`
exports `sendFile(filePath, { chatId, caption, as, parseMode })`.

Never send `.env`, tokens, or other secrets as a file, and don't echo received
inbound files straight back unless explicitly asked.

## Poll output shape

```jsonc
{"messages":[
  {
    "updateId": 123,
    "chatId": "6993517246",
    "from": "username",
    "date": "2026-06-13T14:22:32.000Z",
    "text": "message text OR a file's caption (may be empty)",
    "media": null   // or a media descriptor (see below)
  }
]}
```

`media` is `null` for plain text. For an attachment it is:

```jsonc
{
  "kind": "photo|document|audio|voice|video|video_note|animation|sticker",
  "fileId": "…", "fileUniqueId": "…",
  "fileName": "report.pdf",            // synthesised for photos
  "mimeType": "application/pdf",        // may be null
  "fileSize": 51234,
  "localPath": "/abs/path/inbox/<uid>-report.pdf"  // null if download failed
}
```

Inbound files are **downloaded automatically** to the inbox folder
(`TELEGRAM_INBOX_DIR`, default `inbox/`, gitignored) before messages are handed
to you, so `media.localPath` is ready to read. Download is best-effort: on
failure `localPath` is `null` and `downloadError` carries the reason, but the
message (text/caption + metadata) is never dropped.

## Handling messages (interpret intent)

- **Conversational / status questions** ("hi", "what's the status of X", "what
  does the log say") → answer directly over Telegram, reading repo files / the
  live site / web as needed.
- **Action requests** ("post an article about X", "commit and push", a code
  change) → do the work per the host project's rules, wrapping long/git steps in
  `telegram-lock.mjs guard`, then reply with what you did. If a request is
  ambiguous or destructive (deletes, history rewrites), DON'T guess — ask for
  confirmation and wait for the next message.

### Files: read vs. just store (don't waste tokens)

A file always lands on disk at `media.localPath` first — that costs nothing.
Whether you then **open** it depends on the caption/intent:

- **Read it** if the message signals you want eyes on it — "take a look",
  "summarise this", "what does this say", "extract the figures", "analyse", or
  any question about its contents. Read images natively; read PDFs/docs with the
  relevant document tooling.
- **Just file it** (do NOT read) if the message signals storage only — "add this
  to my records", "save this", "for my files", "keep this for later". Reply
  confirming receipt and where it's saved.
- **No caption / ambiguous** → do NOT auto-open it (a large file could burn
  tokens for nothing). Confirm receipt + the saved location, and ask whether you
  should look at it.

## Safety

- Only the allow-listed `TELEGRAM_CHAT_ID` is ever returned, so the bot ignores
  everyone else. Still refuse anything that conflicts with the host project's
  rules or would expose secrets — **never send `.env` contents or any token over
  Telegram.**
- Inbound files stay **local** (the inbox is gitignored). Don't commit them or
  send them back over Telegram unless explicitly asked.
- Don't delete files in a mounted/permission-gated working tree during an
  unattended run; the lock release is a marker write, never a delete.

## Conversation memory (across runs)

The poll only fetches **new** messages since the stored offset, so the
conversational thread is otherwise lost between runs. `telegram-context.mjs`
keeps a small rolling log of run summaries so each run can pick up where the last
left off:

```bash
node telegram-context.mjs read --entries 8          # at run START — recover the thread
node telegram-context.mjs append --text "<summary>" # at run END (after handling msgs)
printf '%s' "$SUMMARY" | node telegram-context.mjs append   # …or pipe via stdin
```

- **Read** at the start of every run (step 0 above).
- **Append** a 1–3 line summary at the end of any run that actually handled
  messages — what the owner asked, what you did/decided, anything the next run
  should know. Do this *before* releasing the lock. (A run that woke to an empty
  chat handled nothing, so skip the append.)
- Entries are **newest-first** and auto-trimmed to the most recent
  `TELEGRAM_CONTEXT_MAX_ENTRIES` (default 30), so the file never bloats.
- The log is **per-project, local-only runtime state** — it lives at the repo
  root next to `.env` and is **gitignored** (add `telegram-context.md` to the
  project's `.gitignore`). Only this *mechanism* (the script + this contract) is
  shared between projects, never one project's memory.

## Per-run log line

Append one line to the host project's task log:
`[<ISO timestamp>] LEVEL: telegram-bridge — <summary>` (LEVEL = OK / WARN /
ERROR), plus the bridge's own `telegram-bridge.log` trace is written
automatically.
