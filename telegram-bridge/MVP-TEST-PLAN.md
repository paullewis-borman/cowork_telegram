# Telegram watchdog MVP — test plan (adopted 2026-06-27 for Schvitz — see its
# com.schvitz.telegram-watchdog.plist for the launchd hardening this enabled;
# install/verification on Paul's Mac still pending)

Goal: before building a real always-on service, resolve three unknowns. All
steps run in a **Terminal on the Mac**, not inside Cowork — Cowork's sandbox
is a different Linux VM and can't see your Mac's `claude` login.

**Before anything: pause the `schvitz-telegram-poll` Cowork scheduled task**
(Cowork desktop → Scheduled). Telegram's `getUpdates` offset is global per
bot — if the Cowork task and these tests both poll at once, they'll steal
each other's messages. Re-enable it when you're done testing.

## Unknown 1 — does `claude -p` run headless without hitting a login prompt, and what does it bill against?

```bash
cd "/Users/plb/Documents/NewRepo/Schvitz/Schvitz Website"
claude -p "Reply with exactly: HEADLESS_OK" --output-format json
```

Look for: does it return JSON immediately with `"result":"HEADLESS_OK"`, or
does it ask you to log in / set `ANTHROPIC_API_KEY`? Paste back the full JSON
(it includes `total_cost_usd` and a model/usage breakdown) — that tells us
whether this rides your existing Claude Code subscription login or needs
separate API billing. This is the single biggest cost variable in the whole
plan, so don't skip it.

## Unknown 2 — does conversation context actually carry across separate invocations?

```bash
claude -p "Remember this number for later: 4471. Just acknowledge in one line." --output-format json
```

Copy the `session_id` value from the output, then in a **fresh** terminal
(close and reopen, so nothing is held in a live process):

```bash
claude -p "What number did I just tell you?" --resume "<paste-session_id-here>" --output-format json
```

Look for: does it correctly say 4471? If yes, `--resume` is a real fix for
the "does the AI remember our conversation" concern you raised — Telegram
threading can just be "remember the last session id per chat."

## Unknown 3 — does it actually load project memory (CLAUDE.md) and use tools?

```bash
cd "/Users/plb/Documents/NewRepo/Schvitz/Schvitz Website"
claude -p "Read CLAUDE.md and tell me the company name and the name of the daily scheduled task." --allowedTools "Read" --output-format json
```

Should answer "Schvitz Limited" / "schvitz-daily-ai-insight" without you
feeding it any extra context — confirms the project's existing CLAUDE.md
memory works the same way here as it does in Cowork.

## Unknown 4 — end-to-end smoke test with the prototype watcher

`watchdog-mvp.mjs` (in this folder) reuses the existing `telegram.mjs` —
same bot, same `.env`, same offset file — so it's just a different way of
listening for messages, not a new bridge.

```bash
cd "/Users/plb/Documents/NewRepo/cowork_telegram/telegram-bridge"
WATCHDOG_PROJECT_DIR="/Users/plb/Documents/NewRepo/Schvitz/Schvitz Website" \
  node watchdog-mvp.mjs
```

Leave it running in the foreground — it logs every step to the terminal.
From your phone, message the Schvitz bot something like "hi, what's this
project called?" and confirm a reply comes back. Then send a follow-up like
"what did I just ask you?" to check continuity end-to-end (not just in the
isolated Unknown-2 test). `Ctrl+C` to stop. Re-enable the Cowork scheduled
task afterward.

## What "done" looks like

Report back what happened at each step (especially the full JSON from
Unknown 1, and whether Unknown 2/4 actually remembered context). That
decides the next move:

- **Clean results** → harden `watchdog-mvp.mjs` into a real launchd service,
  retire `schvitz-telegram-poll`, update `AGENTS.md`/`CLAUDE.md`.
- **Headless billing turns out to be metered API, not subscription** → still
  probably worth it (eliminates ~280 wasted Cowork sessions/day), but worth
  comparing the per-message API cost against what those idle sessions were
  actually costing before committing.
- **`--resume` doesn't carry context well, or feels fragile** → fall back to
  the alternative you raised: a leaner script that calls a model directly
  (Claude API or OpenRouter) with conversation history and relevant file
  excerpts assembled by hand, and logs its own actions to a file Cowork can
  read later. More work to build (you reimplement the tool-use loop and
  CLAUDE.md loading yourself), but full control over context — worth it only
  if Unknown 2 actually fails.
