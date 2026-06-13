# AGENTS.md — operating the Telegram bridge

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

## The run lifecycle

Each scheduled run is stateless — it listens for new messages, acts on them,
replies, and ends when the chat goes cold. There is no memory between runs; the
offset file guarantees each message is handled exactly once.

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
- `{"messages":[]}` → cold; the lock was auto-released. Run
  `node telegram-lock.mjs release --owner <OWNER>` and **end the run** (the cron
  floor will check again next tick).

### 3. HOT MODE (snappy while chatting, back off when quiet)

Back-off wait seconds `[30, 60, 120, 240, 300]`, starting at 30:
- Listen `--wait <current> --lock --owner <OWNER>`.
- Messages → handle + reply, **reset** the index to 30.
- Empty → advance one step.
- A `--wait 300` that returns empty (~5 min silence) → `release --owner <OWNER>`
  and END the run.
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

## Per-run log line

Append one line to the host project's task log:
`[<ISO timestamp>] LEVEL: telegram-bridge — <summary>` (LEVEL = OK / WARN /
ERROR), plus the bridge's own `telegram-bridge.log` trace is written
automatically.
