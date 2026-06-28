# AGENTS.md — operating the Telegram bridge

**📍 This is the `telegram-bridge` utility's contract** — read it when running the
two-way Telegram bridge.

This file tells a **Cowork/Claude agent** how to run the two-way Telegram bridge
in a scheduled task. It assumes a human has already done the one-time setup in
[README.md](./README.md) (bot token, chat id, `.env`). If `.env` has no
`TELEGRAM_BOT_TOKEN` or an empty `TELEGRAM_CHAT_ID`, the bridge isn't configured
— exit quietly and do nothing.

## Self-scoping convention (read first when vendoring)

This utility ships as a **single self-named folder** (`telegram-bridge/`) that
contains everything it needs: this `AGENTS.md`, the `.mjs` scripts, `.env.example`,
and (at runtime) its own `.env` and local state. To add it to a host project,
**copy the whole folder in and leave it intact** — don't scatter its files, and
never merge it with another utility.

Why the folder matters: `AGENTS.md` is a magic, auto-discovered filename that
agents treat as *whole-project* instructions. If two vendored utilities each drop
an `AGENTS.md` into the **same** folder, they collide and an agent merges their
contracts. Keeping each utility in its own named folder prevents that, and the
pattern scales to any number of utilities:

```
<host-project>/
  telegram-bridge/AGENTS.md  ← this folder
  <other-utility>/AGENTS.md  ← a different utility, its own named folder
  <another-utility>/AGENTS.md← …and so on, one folder each
```

Nested `AGENTS.md` is **nearest-wins**: an agent reads only the one closest to
the files it's touching, never sibling folders — so any number of self-scoped
utilities coexist without clashing. **Hard rule: one utility, one folder; never
flatten two into a shared folder** — that is exactly what re-creates the clash.

Point the host project's root `CLAUDE.md`/`AGENTS.md` at this file with a single
line — *"Telegram bridge → see `telegram-bridge/AGENTS.md`"* — and keep only
project-specific facts (the scheduled-task name, the task-log path) there. Don't
duplicate this contract into the host's project memory (a vendored `AGENTS.md` in
a subfolder is not always auto-discovered, so the explicit pointer matters).

> **Where this folder's files resolve.** By default the scripts read `.env` and
> write their state files (`.telegram-offset.json`, `.telegram-session.lock`,
> `telegram-bridge.log`, `telegram-context.md`, `inbox/`) **in this folder** —
> fully self-contained, nothing leaks to the host project root. If you'd rather
> centralise state at the project root, set `TELEGRAM_BRIDGE_ROOT=/abs/path` (or
> put it in `.env`); all scripts then resolve there. All commands below assume
> you run them with this folder as the script path, e.g. `node
> telegram-bridge/telegram-poll.mjs …` from the project root.

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
(`/newbot`) for this project; (2) copy this `telegram-bridge/` folder into the
repo; (3) put the **new token** plus your **existing chat id** in this folder's
`.env`; (4) create the scheduled poll task. Reuse the chat id (it's just *you*);
never reuse the token.

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

Follow telegram-bridge/AGENTS.md exactly as the operating contract: read the
conversation memory to recover the thread, pick a run owner id, do the config
check, then run the lock-based listen → handle → reply → adaptive-cadence loop.
When the chat goes cold, append a short memory summary, release the lock, and
write one task-log line. Wrap any long or repo-mutating step in
`telegram-lock.mjs guard`.

This is an UNATTENDED run: never take an action that raises a Cowork UI prompt
(file/dir deletes, folder-access requests, plan/approval gates, any permission
dialog) — the prompt never reaches Telegram, so it hangs silently and stalls the
chat. If a request needs one, don't attempt it; tell me it requires the Cowork UI
and to do it (or grant it) there. (Git deletes go via the host publish mechanism,
which runs native git and raises no prompt — see Safety.)

Project-specific facts:
- Scripts live in: <PATH TO THE telegram-bridge/ FOLDER, e.g. telegram-bridge/>
  (state files resolve inside that folder by default; set TELEGRAM_BRIDGE_ROOT to
  the repo root instead if you want state centralised there).
- .env (with TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID) lives in that folder.
- Task log to append one line per run: <PATH TO TASK LOG, e.g. scheduled-task.log>
```

Notes: each project needs its **own** bot token (one bot ≠ many projects — see
Scenario A); the chat id is just *you* and is reused. If `.env` is unconfigured
the run exits quietly, so an enabled task is harmless before setup is finished.

## Alternative runtime: standalone watchdog (no scheduled task)

Everything in *Scheduled-task setup template* above and *The run lifecycle*
below describes one deployment model: a Cowork cron tick that wakes up, runs
`telegram-poll.mjs` under the lock, and goes back to sleep. There is a second
model that doesn't involve Cowork at all: **`watchdog-mvp.mjs`**, a single
always-on Node process the human runs themselves in a terminal on their own
machine. It long-polls continuously (no lock needed — only one process ever
runs against the bot) and, on each message, spawns `claude -p` directly
against the host project (`--resume <session_id>` for continuity across
messages), then sends the result back over Telegram itself — no `AGENTS.md`-
following agent runs the listen/reply loop in this mode; a plain Node script
does.

If you're an agent asked to set this up or explain it: this mode replaces the
entire run lifecycle below (steps 0–5) with one Node process — there is no
scheduled task to create and no lock for you to manage. Point the human at:

```bash
cd telegram-bridge
WATCHDOG_PROJECT_DIR="/abs/path/to/host/project" node watchdog-mvp.mjs
```

**This contract does not (yet) apply inside watchdog mode.** Each Telegram
message reaches `claude -p` as a near-bare prompt — that spawned agent has
only the host project's own `CLAUDE.md` (auto-loaded, confirmed by testing)
and whatever `--allowedTools` the watchdog was started with. It does **not**
read this `AGENTS.md`, so the safety rules, conversation-memory mechanism,
and reply conventions below are not enforced for it. Don't assume parity
between the two runtimes, and don't tell a human it's safe to treat them the
same until that gap is closed (either by injecting this contract into the
spawned prompt, or by documenting a reduced contract specific to this mode).

**Media (added 2026-06-28):** inbound files are handled the same as in the
scheduled-task path — `pollUpdates()` downloads them and sets
`media.localPath` before the watchdog ever sees the message, and it now
forwards that path to `claude -p` instead of dropping non-text messages.
There's no structured way for `claude -p` to return an attachment, so sending
a file back is done by the spawned agent itself, via
`node telegram-send.mjs --file <path> [--caption "…"]` over Bash; the
watchdog's prompt-builder reminds it of this capability on every message.

**The per-bot constraint still applies**: never run the scheduled task and
the watchdog against the same bot at the same time — `getUpdates`'s offset is
global per bot and they will steal each other's messages.

Status: **prototype validated, supervision example exists** — see
`MVP-TEST-PLAN.md` in this folder for what's been verified (headless auth
with no login prompt, `--resume` continuity across separate process
invocations, automatic `CLAUDE.md` load) and what's still open (the
contract-injection gap above, and confirming whether reported cost is a real
charge or an informational draw against a subscription's usage allowance).
"Hardening into a supervised process" is no longer fully open: the Schvitz
project's `com.schvitz.telegram-watchdog.plist` (added 2026-06-27) is a
working launchd LaunchAgent for this exact script — see below.

### Supervising the watchdog with launchd

A foreground terminal only keeps `watchdog-mvp.mjs` running as long as that
terminal stays open. For an unattended, reboot-surviving deployment, wrap it
in a launchd LaunchAgent (same pattern as gitbroker's own service). **There is
no generic template file in this repo yet** — Schvitz's
`com.schvitz.telegram-watchdog.plist` is the worked reference. If you're an
agent setting this up for a **new** project, copy that plist and adapt it:

**Change per project:**
- `Label` — `com.<project>.telegram-watchdog` (must be unique; launchd keys
  off this).
- `ProgramArguments` — absolute path to *that project's own embedded copy* of
  `watchdog-mvp.mjs` (each host project carries its own copy of this folder
  per the self-scoping convention — give each project its own LaunchAgent
  pointed at its own copy, don't share one script path across projects).
- `WorkingDirectory` / `WATCHDOG_PROJECT_DIR` — that project's repo root.
- `StandardOutPath` / `StandardErrorPath` — a project-specific filename under
  `~/Library/Logs/` (don't reuse another project's log file).
- The bot token in that project's `.env` — every project needs its **own**
  bot (per *Setup* above); never point two watchdogs at the same token.

**Stays the same across projects:**
- Absolute `node` / `claude` binary paths (launchd's `PATH` is minimal — find
  them once with `which node` / `which claude` and hardcode them).
- `KeepAlive` + `RunAtLoad` (restarts itself, survives reboots).
- The one-time Full Disk Access grants for `node` and `claude` in System
  Settings → Privacy & Security (`claude` may need its own grant, separate
  from `node`'s) — once granted to those binaries, they apply no matter which
  project's LaunchAgent invokes them.

**Once the new LaunchAgent is confirmed working** (message that project's
bot, get a reply, close the terminal, confirm it still replies — ideally
confirm across a reboot too): disable that project's old cron-based scheduled
task (the `*/5 * * * *` listener), the same way `schvitz-telegram-poll` was
retired in favour of its watchdog. Never leave both running against the same
bot — see the per-bot constraint above.

If you do this generalization work for a project, consider promoting it into
an actual `com.example.telegram-watchdog.plist.template` in this folder so
the next project doesn't have to reverse-engineer Schvitz's copy from
scratch — that's still outstanding.

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

### Tools that DO work unattended (you are not as locked-down as you think)

The Safety section lists what to avoid because it raises a Cowork UI prompt. The
flip side matters just as much: **most ordinary tool calls are pre-authorised in
an unattended run and raise no prompt** — reading files, running shell commands in
the granted folders, fetching URLs, publishing via the host's git mechanism, and
**web search**. Do not refuse these or claim you "can't" — you can.

- **Web search works.** It does not require user permission and raises no UI
  prompt. When asked to look something up, do it and reply with the result.
- **Deferred tools must be loaded before use — "not in my tool list" ≠
  "blocked".** Some tools (e.g. `WebSearch`, `mcp__workspace__web_fetch`) are
  *deferred*: their schemas aren't loaded at start, so they aren't directly
  callable yet. That is NOT a permission block. Load the schema first with
  `ToolSearch` (query `select:WebSearch`, or keyword search), then call the tool
  normally. If you ever think you can't do a web search, the cause is almost
  always that you skipped this step — load it via ToolSearch and proceed.

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
- **No human-in-the-loop actions in an unattended run.** A scheduled poll run has
  no one watching the Cowork UI, so any action that raises a Cowork UI prompt —
  a file/dir delete, a folder-access request, a plan/approval gate — will hang
  silently (the prompt never reaches Telegram) and stall the whole chat. Never
  attempt such an action. If a request needs one, do **not** try it: reply to the
  user that it requires the Cowork UI and that they should do it (or grant it)
  there, then carry on with whatever else you can. (Git deletes go via the host's
  publish mechanism — a native git-publish broker running on the host — which
  raises no prompt.) In particular, **creating or editing a scheduled task is
  itself a UI-prompt action** — don't do it from a telegram session; ask the user
  to make the change in the Cowork UI.

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
- The log is **per-project, local-only runtime state** — it lives in this folder
  next to `.env` and is **gitignored** (`telegram-context.md`). Only this
  *mechanism* (the script + this contract) is shared between projects, never one
  project's memory.

## Per-run log line

Append one line to the host project's task log:
`[<ISO timestamp>] LEVEL: telegram-bridge — <summary>` (LEVEL = OK / WARN /
ERROR), plus the bridge's own `telegram-bridge.log` trace is written
automatically.
