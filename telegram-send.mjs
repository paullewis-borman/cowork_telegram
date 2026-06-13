#!/usr/bin/env node
/**
 * telegram-send.mjs — Claude → you.
 *
 * Text:
 *   node telegram-send.mjs "your message"            # text as arg
 *   echo "your message" | node telegram-send.mjs     # text from stdin (multi-line)
 *
 * Files (photo or document):
 *   node telegram-send.mjs --file report.pdf
 *   node telegram-send.mjs --file shot.png --caption "the dashboard"
 *   node telegram-send.mjs --file pic.png --document      # force lossless document
 *
 * Options:
 *   --plain          disable Markdown parsing (text / caption sent literal)
 *   --chat <id>      override target chat id (default: TELEGRAM_CHAT_ID)
 *   --file <path>    send a local file instead of a text message
 *   --caption <text> caption for the file (file mode only)
 *   --photo          force the file to be sent as a photo (inline, re-compressed)
 *   --document       force the file to be sent as a document (exact bytes)
 *                    Default routing: images → photo, everything else → document.
 *
 * Reads TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID from the bridge-root .env.
 */

import { loadDotEnv, sendMessage, sendFile } from './telegram.mjs';

loadDotEnv();

const argv = process.argv.slice(2);
let plain = false;
let chatId;
let filePath;
let caption;
let as; // 'photo' | 'document' | undefined (auto)
const parts = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--plain') plain = true;
  else if (a === '--chat') chatId = argv[++i];
  else if (a === '--file') filePath = argv[++i];
  else if (a === '--caption') caption = argv[++i];
  else if (a === '--photo') as = 'photo';
  else if (a === '--document') as = 'document';
  else if (a === '--as') as = argv[++i];
  else parts.push(a);
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  let data = '';
  for await (const c of process.stdin) data += c;
  return data.trim();
}

const parseMode = plain ? null : undefined;

try {
  if (filePath) {
    // caption priority: --caption, else positional text, else stdin
    const cap = caption || (parts.length ? parts.join(' ') : await readStdin()) || undefined;
    await sendFile(filePath, { chatId, caption: cap, as, parseMode });
    console.log('sent');
  } else {
    const text = parts.length ? parts.join(' ') : await readStdin();
    if (!text) {
      console.error('Nothing to send. Pass text, pipe via stdin, or use --file <path>.');
      process.exit(1);
    }
    await sendMessage(text, { parseMode, chatId });
    console.log('sent');
  }
} catch (e) {
  console.error('send failed:', e.message);
  process.exit(1);
}
