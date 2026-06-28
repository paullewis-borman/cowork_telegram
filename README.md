# cowork-telegram

> 🤖 **Agents:** your operating contract is [`telegram-bridge/AGENTS.md`](./telegram-bridge/AGENTS.md) — read that, not this README. (This README is for humans.)

## Repository layout (self-scoping)

The whole bridge lives in one self-named folder so it drops into any host project
without colliding with other vendored utilities:

```
cowork-telegram/               ← repo root: human docs
  README.md                    ·  this file (for humans)
  telegram-bridge/             ← the drop-in folder (self-contained)
    AGENTS.md                  ·  the agent's operating contract
    telegram.mjs               ·  shared library
    telegram-send.mjs          ·  Claude → you
    telegram-poll.mjs          ·  you → Claude
    telegram-lock.mjs          ·  overlap guard
    telegram-context.mjs       ·  conversation memory
    broker-publish.mjs         ·  optional publish client
    watchdog-mvp.mjs           ·  alternative runtime: standalone always-on listener (prototype)
    MVP-TEST-PLAN.md           ·  open questions + test steps for the watchdog prototype
    .env.example               ·  copy to .env (token + chat id)
```

**To wire the bridge into a project, copy the whole `telegram-bridge/` folder in**
and leave it intact. By default it keeps its `.env` and local state inside that
folder (nothing leaks to the host root); set `TELEGRAM_BRIDGE_ROOT` to centralise
state at the repo root instead. Because it's a self-named folder carrying its own
`AGENTS.md`, it never collides with another vendored utility — see the
*Self-scoping convention* in [`telegram-bridge/AGENTS.md`](./telegram-bridge/AGENTS.md).
The command examples below assume you run them from inside `telegram-bridge/`.

A small, **dependency-free** two-way Telegram bridge for Cowork (Claude) projects.
It lets a Cowork agent message you on Telegram, and lets a scheduled task pick up
your replies and act on them — chat, status queries, or "go do this" requests.

No off-the-shelf Telegram connector needed: this talks straight to the Telegram
Bot API over plain HTTPS using Node's global `fetch` (Node 18+). Drop the
`telegram-bridge/` folder into any project and you have a reusable bridge.

```
Claude → you   sendMessage()   (telegram-send.mjs)
you → Claude   pollUpdates()   (telegram-poll.mjs, run by a scheduled task)
```

## Files

| File | Role |
| --- | --- |
| `telegram.mjs` | Shared library: send, poll, the session lock, `.env` loader, logging. Imported by the CLIs. |
| `telegram-send.mjs` | CLI — Claude → you. Send a message (arg or stdin), Markdown with plain-text fallback, 4096-char chunking. Also sends files with `--file` (photo or document). |
| `telegram-poll.mjs` | CLI — you → Claude. Long-polls for your new messages, prints them as JSON, advances the offset so each is handled exactly once. |
| `telegram-lock.mjs` | CLI — overlap guard. Keeps one run's lock warm across listen → process → reply so a concurrent scheduled tick yields. |
| `telegram-context.mjs` | CLI — conversation memory. Reads/appends a small rolling log of run summaries (`telegram-context.md`, gitignored) so each stateless run can recover the thread. `read [--entries N]` / `append [--text "…"]`. |
| `broker-publish.mjs` | CLI (optional) — commit & push this repo via a native git-publish broker service running on your machine, instead of running native git in the sandbox. See [Publishing via a git-publish broker](#publishing-via-a-git-publish-broker-optional). |
| `watchdog-mvp.mjs` | **Prototype.** An alternative to the scheduled-task model below: a single always-on Node process you run yourself that long-polls continuously and spawns `claude -p` directly per message. See [Alternative: a standalone watchdog process](#alternative-a-standalone-watchdog-process-experimental). |

## Point an AI agent at this repo (which scenario?)

To add this bridge to a project, open that project in Cowork and paste it this
prompt:

```text
Add the Telegram bridge from https://github.com/paullewis-borman/cowork_telegram — read its README.md and AGENTS.md, work out whether I've already set this up on this machine or it's a fresh install, and wire this project up accordingly.
```

`AGENTS.md` carries the detection recipe. The two cases:

- **Fresh install** — first time on this machine: do *Setup* below (create a bot
  with BotFather, capture your chat id).
- **Already used here** — you've run the bridge for another project. You reuse
  the scripts and your **existing chat id**, but **create a new bot** for this
  project. Telegram's `getUpdates` is **per-bot**, so two projects must never
  share one token — they'd steal each other's messages. Same you, different bot.

## Setup

1. **Create a bot.** Message [@BotFather](https://t.me/BotFather) → `/newbot`, copy the token.
2. **Configure.** `cp .env.example .env` and set `TELEGRAM_BOT_TOKEN`.
3. **Capture your chat id.** Send your bot any message, then:

   ```bash
   node telegram-poll.mjs --once
   ```

   Read the `chatId` from the output and put it in `.env` as `TELEGRAM_CHAT_ID`.
   This doubles as an allow-list — the bridge only ever acts on messages from
   this chat, ignoring everyone else.

That's it. No `npm install` — there are no dependencies.

## Usage

Send yourself a message:

```bash
node telegram-send.mjs "Build finished ✅"
echo "multi-line\nmessage" | node telegram-send.mjs        # from stdin
node telegram-send.mjs --plain "literal *no* markdown"
```

Send yourself a file (photo or document):

```bash
node telegram-send.mjs --file report.pdf --caption "this quarter's numbers"
node telegram-send.mjs --file chart.png                     # images auto-sent as a photo
node telegram-send.mjs --file logo.png --document           # force lossless document
```

Images (`.jpg/.jpeg/.png/.webp/.gif`) are sent as a photo (inline, re-compressed);
everything else as a document (exact bytes). Force with `--photo` / `--document`.
Telegram caps bot uploads at 50 MB. Programmatic: `sendFile(path, { caption, as })`.

Check for new messages from you:

```bash
node telegram-poll.mjs --once          # instant check, prints {"messages":[...]}
node telegram-poll.mjs --wait 50        # long-poll, returns the instant one lands
```

### Receiving files (photos & documents)

Send the bot a photo or a document — with or without a caption — and the poller
downloads it to an **inbox folder** (`TELEGRAM_INBOX_DIR`, default `inbox/`,
gitignored) and returns its local path so the agent can read it:

```jsonc
{"messages":[{ "text": "summarise this", "media": {
  "kind": "document", "fileName": "report.pdf", "mimeType": "application/pdf",
  "localPath": "/…/inbox/<uid>-report.pdf"
}}]}
```

`text` carries the caption (or the message text). The agent decides whether to
actually *open* the file based on what you said — see
[AGENTS.md](./AGENTS.md#files-read-vs-just-store-dont-waste-tokens).

## Wiring it into a Cowork scheduled task

> The full agent-facing operating contract lives in **[AGENTS.md](./AGENTS.md)** —
> point your project's `CLAUDE.md` at it with one line instead of duplicating the
> rules. The sketch below is the gist.

Create a scheduled task (e.g. cron `*/5 * * * *`) that runs the **inbound
listener**. On each wake it long-polls, and while you're actively chatting it
stays hot and replies near-instantly, backing off as the chat goes quiet, then
ends and lets the cron floor resume. A sketch of the loop the agent runs:

```bash
OWNER="run-$(date +%s%N)"

# Try to take the session lock and listen for up to ~50s.
OUT=$(node telegram-poll.mjs --wait 50 --lock --owner "$OWNER")
# {"locked":true}        → another run owns it, yield this tick
# {"messages":[...]}     → handle each message, then reply with telegram-send.mjs
# {"messages":[]}        → cold; the lock was auto-released, end the run
```

When the agent does heavy/long work between listens, wrap it so the lock stays
warm (a concurrent tick will yield until it finishes):

```bash
node telegram-lock.mjs guard --owner "$OWNER" -- node some-long-job.mjs
# ... and when the chat goes cold:
node telegram-lock.mjs release --owner "$OWNER"
```

### Why the session lock (owner tokens + heartbeat)

Each scheduled run makes many independent shell calls in fresh sandboxes (pids
reset, no shared memory). One run picks a single `--owner` id and threads it
through every poll/lock call, so its own later calls *refresh* the lock instead
of yielding to it; a different concurrent run finds the lock fresh and yields
entirely. A 5-minute TTL is just a crash-safety net — the heartbeat keeps the
lock fresh while a run is alive, and the TTL auto-frees it only if a run dies
holding it.

**No deletes anywhere.** On some sandboxed/mounted filesystems, deleting a file
is permission-gated and fails in an unattended run. So the lock is never
deleted — "release" *writes* a `released:true` marker, and stale/released locks
are treated as free. The same principle keeps the bridge safe to run unattended.

## Alternative: a standalone watchdog process (experimental)

Everything above runs the inbound listener as a **Cowork scheduled task** — a
`*/5 * * * *` cron tick that wakes up, checks for messages, and goes back to
sleep. There's a second way to run it: **`watchdog-mvp.mjs`**, a single
always-on Node process you start yourself in a terminal on your own machine
(not inside Cowork). It long-polls Telegram continuously — no cron, no lock
file, no concurrent-run problem, since there's only ever one process — and on
each incoming message it spawns `claude -p` directly against the host
project, then sends back whatever it returns.

```bash
cd telegram-bridge
WATCHDOG_PROJECT_DIR="/abs/path/to/host/project" node watchdog-mvp.mjs
```

Why you might reach for this instead:

- **Cost.** A scheduled task spends a session waking up every 5 minutes
  whether or not you've actually messaged it. The watchdog only spends
  anything when a real message arrives.
- **It runs natively on your machine, not in the Cowork sandbox** — so it
  needs your own, separately-authenticated `claude` CLI (`claude login`), not
  Cowork's bundled engine. The two are isolated from each other: different
  processes, different credential stores, no shared state.

What testing so far has shown (full detail in `MVP-TEST-PLAN.md`): headless
`claude -p` runs with no login prompt; `--resume <session_id>` reliably
carries conversation context across separate process invocations, so the
watchdog persists the last session id (`.watchdog-session.json`) and resumes
it, falling back to a fresh session after `WATCHDOG_IDLE_RESET_MIN` minutes
idle (default 6h); and the host project's `CLAUDE.md` loads automatically,
same as it would in Cowork. Cost is lumpy rather than flat: a *cold* call
(fresh session) runs roughly **$0.075**, almost all of it a one-time
~12k-token cache write of the system prompt + `CLAUDE.md`; a *warm*
`--resume` call inside that cache's window drops to roughly **$0.007**, since
it reads the cache instead of rewriting it. Whether that figure is an actual
charge or just an informational draw against a Pro/Max plan's usage allowance
depends on how the `claude` CLI is authenticated — still worth checking
per-install.

**Media (added 2026-06-28):** inbound photos/documents work the same way as
in the scheduled-task path — `pollUpdates()` already downloads them and sets
`media.localPath`, and the watchdog now passes that path through to
`claude -p` instead of skipping the message. Outbound is different: there's
no structured "send a file" return value from `claude -p`, so the spawned
agent sends files back itself, by running `telegram-send.mjs --file <path>
[--caption "…"]` via Bash — the prompt the watchdog builds reminds it how to
do this on every turn.

⚠️ **Known gap:** unlike the scheduled-task path, the watchdog does **not**
inject this folder's `AGENTS.md` contract into the prompt it sends — each
message goes to `claude -p` close to as-is (plus the host project's own
`CLAUDE.md`, auto-loaded). The safety rules, file read-vs-store guidance, and
reply conventions documented in `AGENTS.md` are not yet enforced in this
mode. Don't assume parity between the two runtimes.

⚠️ **The same per-bot rule still applies.** Telegram's `getUpdates` offset is
global per bot — run *either* the scheduled task *or* the watchdog against a
given bot, never both at once; they'll steal each other's messages.

**Status: a hardened example exists, not yet a generic template here.** The
Schvitz project's `com.schvitz.telegram-watchdog.plist` (added 2026-06-27) is
a working launchd LaunchAgent for this script, following the same pattern as
gitbroker's own launchd service: absolute `node`/`claude` paths (launchd's
PATH is minimal), logs to `~/Library/Logs/` rather than the repo (same
TCC/Full-Disk-Access reasoning — `claude` may need its own grant, separate
from `node`'s), and `KeepAlive`+`RunAtLoad` so it restarts itself and survives
reboots. It hasn't yet been generalised into a copy-paste template in this
repo, and as of this writing Paul hasn't yet installed/verified it survives a
terminal close or reboot on a live deployment. See `MVP-TEST-PLAN.md` for the
open questions this resolved and what's still outstanding before the launchd
model fully replaces the scheduled-task model project-wide.

## Local state & logging (all gitignored)

| File | Purpose |
| --- | --- |
| `.telegram-offset.json` | Last processed `update_id` — guarantees each message is handled exactly once across runs. |
| `.telegram-session.lock` | Owner-token overlap guard (see above). |
| `telegram-bridge.log` | Per-action trace (`LISTEN.start`, `LOCK.acquired/busy/released`, `POLL.chunk`, `RECV`, `SEND`, …) — `tail -f` it to debug responsiveness. |

## State location (self-contained by default)

By default the scripts read `.env` and write their state files in **their own
directory** — i.e. inside `telegram-bridge/`, so the bridge is fully
self-contained and nothing leaks to the host project root. If you'd rather keep
state at your project root, set `TELEGRAM_BRIDGE_ROOT=/abs/path/to/project` in
the environment (or `.env`).

## Publishing via a git-publish broker (optional)

If a Cowork scheduled task needs to **commit and push changes back to this
repo**, do **not** run `git add/commit/push` inside the Cowork sandbox. On a
bindfs-mounted working tree, in-sandbox git is fragile: it leaves un-removable
`.git/index.lock` files and hits "Operation not permitted" during object/lock
cleanup, which can wedge the repo. Instead, hand the git work to a **native
git-publish broker** — a tiny service running on your own machine that performs
git in the real folder with your own credentials, exposing a `POST /publish`
HTTP endpoint authenticated by a per-repo secret. `broker-publish.mjs` is a
self-contained client for any such broker (configured separately on the host);
it needs only the `BROKER_SECRET` in this folder's `.env`.

### What it does

It finds the broker on your LAN, authenticates with a per-repo secret, and POSTs
`/publish`. The broker then runs `git fetch` → `git merge --ff-only` →
`git add`/`rm` → `git commit` → `git push` in the real checkout and returns the
new commit SHA. No GitHub token ever lives in the sandbox, and the caller never
names a path or repo — **the secret itself maps to exactly one repo** on the
broker side, so it's the only capability passed.

It's a thin convenience wrapper around a raw POST. What it adds: broker
**discovery** (so you don't hardcode the Mac's LAN IP — it tries a cached host,
then `BROKER_URL`, then scans your subnet, then the default gateway,
health-checking `/health`), **host caching** to `.broker-host` for instant
subsequent runs, `.env` secret loading, a clean `--add`/`--rm`/`--message` CLI,
and meaningful **exit codes** (`0` ok/no-op · `1` broker reported failure ·
`2` broker unreachable · `3` bad usage / no secret) so an unattended task can log
properly and STOP on a real failure. For a one-off you could hand-roll the POST;
for a scheduled task that must survive an IP change and log cleanly, the wrapper
earns its place.

### Setup

1. **Run the broker** on your machine and **register this repo** in its
   `registry.json`: `{ "name": "...", "path": "<abs host path to this repo>",
   "secret": "<unique secret>" }`, then reload the broker.
2. **Add the secret here.** Put the *same* value in this repo's gitignored
   `.env` as `BROKER_SECRET=...`. (Optionally `BROKER_URL` / `BROKER_PORT` —
   default port is `4747` — to skip discovery.)

### Usage

```bash
# commit one or more files and push (paths are relative to the git repo root)
node telegram-bridge/broker-publish.mjs --message "update telegram bridge" \
  --add telegram-bridge/telegram.mjs --add README.md

# stage deletions too
node telegram-bridge/broker-publish.mjs --message "drop old script" --rm old-thing.mjs

# point at a known broker (skips discovery)
node telegram-bridge/broker-publish.mjs --message "msg" --add file --url http://192.168.1.10:4747
```

Exit `0` means published (or nothing to commit); non-zero prints why (e.g.
`could not reach the publish broker` if the host is asleep). `--add`/`--rm` paths
are relative to the **git repo root**; `BROKER_SECRET` is never printed.

> **Note:** `broker-publish.mjs` reads its `.env`/`.broker-host` from its **own
> folder** (`telegram-bridge/`). The `--add`/`--rm` paths are relative to the git
> repo root (the broker resolves them on the host), so it works wherever the
> folder is dropped — no path constant to adjust.

## Safety notes

- The bridge **only** ever acts on messages from `TELEGRAM_CHAT_ID`.
- It never sends `.env` contents or the bot token over Telegram.
- Configure it before relying on it: every script no-ops cleanly if the token /
  chat id are unset.

## License

MIT
