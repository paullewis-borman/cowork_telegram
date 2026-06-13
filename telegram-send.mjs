#!/usr/bin/env node
/**
 * telegram-send.mjs — Claude → you.
 *
 * Usage:
 *   node telegram-send.mjs "your message"      # text as arg
 *   echo "your message" | node telegram-send.mjs   # text from stdin (multi-line)
 *
 * Options:
 *   --plain         disable Markdown parsing (send literal text)
 *   --chat <id>     override target chat id (default: TELEGRAM_CHAT_ID)
 *
 * Reads TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID from the bridge-root .env.
 */

import { loadDotEnv, sendMessage } from './telegram.mjs';

loadDotEnv();

const argv = process.argv.slice(2);
let plain = false;
let chatId;
const parts = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--plain') plain = true;
  else if (argv[i] === '--chat') chatId = argv[++i];
  else parts.push(argv[i]);
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  let data = '';
  for await (const c of process.stdin) data += c;
  return data.trim();
}

const text = parts.length ? parts.join(' ') : await readStdin();
if (!text) {
  console.error('Nothing to send. Pass text as an argument or via stdin.');
  process.exit(1);
}

try {
  await sendMessage(text, { parseMode: plain ? null : undefined, chatId });
  console.log('sent');
} catch (e) {
  console.error('send failed:', e.message);
  process.exit(1);
}
