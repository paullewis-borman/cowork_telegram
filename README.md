# cowork-telegram

A small, **dependency-free** two-way Telegram bridge for Cowork (Claude) projects.
It lets a Cowork agent message you on Telegram, and lets a scheduled task pick up
your replies and act on them — chat, status queries, or "go do this" requests.

No off-the-shelf Telegram connector needed: this talks straight to the Telegram
Bot API over plain HTTPS using Node's global `fetch` (Node 18+). Drop the four
`.mjs` files into any project and you have a reusable bridge.

```
Claude → you   sendMessage()   (telegram-send.mjs)
you → Claude   pollUpdates()   (telegram-poll.mjs, run by a scheduled task)
```

## Files

| File | Role |
| --- | --- |
| `telegram.mjs` | Shared library: send, poll, the session lock, `.env` loader, logging. Imported by the three CLIs. |
| `telegram-send.mjs` | CLI — Claude → you. Send a message (arg or stdin), Markdown with plain-text fallback, 4096-char chunking. |
| `telegram-poll.mjs` | CLI — you → Claude. Long-polls for your new messages, prints them as JSON, advances the offset so each is handled exactly once. |
| `telegram-lock.mjs` | CLI — overlap guard. Keeps one run's lock warm across listen → process → reply so a concurrent scheduled tick yields. |
| `broker-publish.mjs` | CLI (optional) — commit & push this repo via a [gitbroker](https://github.com/paullewis-borman/gitbroker) service running on your machine, instead of running native git in the sandbox. See [Publishing via gitbroker](#publishing-via-gitbroker-optional). |

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

## Local state & logging (all gitignored)

| File | Purpose |
| --- | --- |
| `.telegram-offset.json` | Last processed `update_id` — guarantees each message is handled exactly once across runs. |
| `.telegram-session.lock` | Owner-token overlap guard (see above). |
| `telegram-bridge.log` | Per-action trace (`LISTEN.start`, `LOCK.acquired/busy/released`, `POLL.chunk`, `RECV`, `SEND`, …) — `tail -f` it to debug responsiveness. |

## Embedding in a subfolder

By default the scripts read `.env` and write their state files in **their own
directory**. If you copy them into a subfolder (e.g. `backend/scripts/`) but want
state at your project root, set `TELEGRAM_BRIDGE_ROOT=/abs/path/to/project` in
the environment (or `.env`).

## Publishing via gitbroker (optional)

If a Cowork scheduled task needs to **commit and push changes back to this
repo**, do **not** run `git add/commit/push` inside the Cowork sandbox. On a
bindfs-mounted working tree, in-sandbox git is fragile: it leaves un-removable
`.git/index.lock` files and hits "Operation not permitted" during object/lock
cleanup, which can wedge the repo. Instead, hand the git work to
[**gitbroker**](https://github.com/paullewis-borman/gitbroker) — a tiny native
service running on your own machine that performs git in the real folder with
your own credentials. `broker-publish.mjs` is the client for it.

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
# commit one or more files and push
node broker-publish.mjs --message "update telegram bridge" --add telegram.mjs --add README.md

# stage deletions too
node broker-publish.mjs --message "drop old script" --rm old-thing.mjs

# point at a known broker (skips discovery)
node broker-publish.mjs --message "msg" --add file --url http://192.168.1.10:4747
```

Exit `0` means published (or nothing to commit); non-zero prints why (e.g.
`could not reach gitbroker` if the host is asleep). Paths are relative to the
repo root. `BROKER_SECRET` is never printed.

> **Note:** `broker-publish.mjs` here resolves the repo root as its **own
> directory** (these scripts live at the repo root). If you relocate it into a
> subfolder, adjust the `REPO` constant near the top accordingly.

## Safety notes

- The bridge **only** ever acts on messages from `TELEGRAM_CHAT_ID`.
- It never sends `.env` contents or the bot token over Telegram.
- Configure it before relying on it: every script no-ops cleanly if the token /
  chat id are unset.

## License

MIT
