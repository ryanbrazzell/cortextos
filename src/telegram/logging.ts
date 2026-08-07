/**
 * Telegram message logging and last-sent context caching.
 * Matches the bash send-telegram.sh outbound logging (lines 100-108)
 * and last-sent cache (lines 111-113).
 */

import {
  appendFileSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  openSync,
  readSync,
  closeSync,
  statSync,
} from 'fs';
import { join, dirname } from 'path';
import { logEvent } from '../bus/event.js';
import type { BusPaths, TelegramMessage } from '../types/index.js';
import { stripControlChars } from '../utils/validate.js';

/**
 * Optional metadata attached to an outbound Telegram message log entry.
 * Fields are all optional so existing callers that pass nothing still
 * produce the same JSONL shape as before this extension.
 *
 * - `parseMode`: which parse_mode the first send attempt used. "html"
 *   for the default path (Markdown-to-HTML conversion), "none" when the
 *   caller used --plain-text.
 */
export interface OutboundLogMetadata {
  parseMode?: 'html' | 'none';
}

/**
 * Append an outbound message to the agent's JSONL log.
 * Path: {ctxRoot}/logs/{agentName}/outbound-messages.jsonl
 */
export function logOutboundMessage(
  ctxRoot: string,
  agentName: string,
  chatId: string | number,
  text: string,
  messageId: number,
  metadata?: OutboundLogMetadata,
): void {
  const logDir = join(ctxRoot, 'logs', agentName);
  mkdirSync(logDir, { recursive: true });

  // Only emit metadata fields that were actually set so the base log shape
  // stays unchanged for callers that pass nothing (backwards compat).
  const meta: Record<string, unknown> = {};
  if (metadata?.parseMode !== undefined) meta.parse_mode = metadata.parseMode;

  const entry = JSON.stringify({
    timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    agent: agentName,
    chat_id: String(chatId),
    text,
    message_id: messageId,
    ...meta,
  });

  appendFileSync(join(logDir, 'outbound-messages.jsonl'), entry + '\n', 'utf-8');
}

/**
 * How much of the tail of outbound-messages.jsonl to scan when looking for the
 * most recent send. The log is append-only and grows without bound (production
 * logs are ~256KB after 11 days, longest single entry ~6KB), so the boot path
 * reads a bounded window instead of the whole file.
 *
 * Consequence worth naming: if the window happens to contain no entry for the
 * chat being asked about, this reports "no recent send" even though an older one
 * exists further back. That is the fail-open direction on purpose — the caller
 * uses this to SUPPRESS a message, so an inconclusive read must let the message
 * through rather than silence an agent.
 */
const OUTBOUND_TAIL_SCAN_BYTES = 64 * 1024;

/**
 * Epoch-ms timestamp of the most recent outbound Telegram message this agent
 * sent to `chatId`, or null if there is no such message in the scanned tail
 * (or the log is missing/unreadable/malformed).
 *
 * Null means "don't know", never "definitely nothing" — see
 * OUTBOUND_TAIL_SCAN_BYTES. Callers must treat null as the permissive case.
 */
export function getLastOutboundTimestamp(
  ctxRoot: string,
  agentName: string,
  chatId: string | number,
): number | null {
  const logPath = join(ctxRoot, 'logs', agentName, 'outbound-messages.jsonl');
  const chatIdStr = String(chatId);

  let raw: string;
  try {
    if (!existsSync(logPath)) return null;
    const size = statSync(logPath).size;
    if (size === 0) return null;
    const start = Math.max(0, size - OUTBOUND_TAIL_SCAN_BYTES);
    const length = size - start;
    const buf = Buffer.alloc(length);
    const fd = openSync(logPath, 'r');
    try {
      readSync(fd, buf, 0, length, start);
    } finally {
      closeSync(fd);
    }
    raw = buf.toString('utf-8');
    // A non-zero start almost certainly lands mid-entry; drop that fragment so
    // it cannot parse into a bogus record. Defence-in-depth only: with today's
    // one-object-per-line format a truncated fragment already fails JSON.parse
    // and is skipped below, so disabling this branch changes no outcome
    // (confirmed by mutation testing). Kept because it is the correct shape for
    // a bounded tail read and stays correct if the entry format ever changes.
    if (start > 0) {
      const firstNewline = raw.indexOf('\n');
      raw = firstNewline === -1 ? '' : raw.slice(firstNewline + 1);
    }
  } catch {
    return null;
  }

  // Scan backwards: the newest matching entry wins and lets us stop early.
  // Entries are appended in send order, so the last match is the most recent.
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      if (String(obj.chat_id) !== chatIdStr) continue;
      const ms = Date.parse(obj.timestamp);
      if (Number.isNaN(ms)) continue;
      return ms;
    } catch { /* skip malformed */ }
  }
  return null;
}

/**
 * Append an inbound message to the agent's JSONL log.
 * Path: {ctxRoot}/logs/{agentName}/inbound-messages.jsonl
 */
export function logInboundMessage(
  ctxRoot: string,
  agentName: string,
  rawMessage: object,
): void {
  const logDir = join(ctxRoot, 'logs', agentName);
  mkdirSync(logDir, { recursive: true });

  const entry = JSON.stringify({
    ...rawMessage,
    archived_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    agent: agentName,
  });

  appendFileSync(join(logDir, 'inbound-messages.jsonl'), entry + '\n', 'utf-8');
}

/**
 * Persist an inbound Telegram message to the daemon's JSONL archive AND
 * emit a `message/telegram_received` bus event so dashboards and
 * experiment cycles can count fleet-wide inbound traffic. Symmetric with
 * `telegram_sent` emitted from the outbound path in `cortextos bus
 * send-telegram`.
 *
 * Wrapped: a logEvent failure (e.g. unwritable analytics dir) must not
 * break message processing — the logged inbound JSONL still goes through.
 */
export function recordInboundTelegram(
  paths: BusPaths,
  ctxRoot: string,
  agentName: string,
  org: string,
  fromName: string,
  msg: TelegramMessage,
  log?: (m: string) => void,
): void {
  const text = (msg.text || msg.caption || '').toString();
  const replyTo = summarizeReplyTarget(msg.reply_to_message);
  logInboundMessage(ctxRoot, agentName, {
    message_id: msg.message_id,
    from: msg.from?.id,
    from_name: fromName,
    chat_id: msg.chat?.id,
    text,
    ...(replyTo ? {
      reply_to_message_id: replyTo.messageId,
      reply_to_text: replyTo.text,
      reply_to_has_media: replyTo.hasMedia,
    } : {}),
    timestamp: new Date().toISOString(),
  });

  const hasMedia = !!(msg.photo || msg.document || msg.voice || msg.audio || msg.video || msg.video_note);
  try {
    logEvent(paths, agentName, org, 'message', 'telegram_received', 'info', {
      chat_id: String(msg.chat?.id ?? ''),
      message_id: msg.message_id,
      from_id: msg.from?.id,
      from_name: fromName,
      has_media: hasMedia,
      text_chars: text.length,
      ...(replyTo ? {
        reply_to_message_id: replyTo.messageId,
        reply_to_text_chars: replyTo.text.length,
        reply_to_has_media: replyTo.hasMedia,
      } : {}),
    });
  } catch (err) {
    log?.(`logEvent(telegram_received) failed: ${err}`);
  }
}

function summarizeReplyTarget(msg: TelegramMessage | undefined): {
  messageId: number;
  text: string;
  hasMedia: boolean;
} | null {
  if (!msg) return null;

  const parts: string[] = [];
  if (msg.text) parts.push(stripControlChars(msg.text));
  if (msg.caption) parts.push(stripControlChars(msg.caption));
  if (msg.document) parts.push(`[document: ${msg.document.file_name ?? 'file'}]`);
  if (msg.photo) parts.push('[photo]');
  if (msg.video) parts.push('[video]');
  if (msg.video_note) parts.push('[video note]');
  if (msg.voice) parts.push('[voice message]');
  if (msg.audio) parts.push('[audio]');

  const hasMedia = !!(msg.photo || msg.document || msg.voice || msg.audio || msg.video || msg.video_note);
  return {
    messageId: msg.message_id,
    text: parts.join('\n').slice(0, 500),
    hasMedia,
  };
}

/**
 * Cache the last-sent text for a given chat.
 * Path: {ctxRoot}/state/{agentName}/last-telegram-{chatId}.txt
 */
export function cacheLastSent(
  ctxRoot: string,
  agentName: string,
  chatId: string | number,
  text: string,
): void {
  const stateDir = join(ctxRoot, 'state', agentName);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, `last-telegram-${chatId}.txt`), text, 'utf-8');
}

/**
 * Read the last-sent text for a given chat, or null if not cached.
 */
export function readLastSent(
  ctxRoot: string,
  agentName: string,
  chatId: string | number,
): string | null {
  const filePath = join(ctxRoot, 'state', agentName, `last-telegram-${chatId}.txt`);
  if (!existsSync(filePath)) {
    return null;
  }
  return readFileSync(filePath, 'utf-8');
}

/**
 * Build a short recent conversation snippet for context injection.
 * Reads the last cputime         unlimited
filesize        unlimited
datasize        unlimited
stacksize       7MB


/**
 * Build a short recent conversation snippet for context injection.
 * Reads the last `limit` messages (combined inbound + outbound) for the
 * given agent/chatId, sorts by timestamp, and returns a formatted string.
 * Returns null if no history is available.
 */
export function buildRecentHistory(
  ctxRoot: string,
  agentName: string,
  chatId: string | number,
  limit: number = 6,
): string | null {
  const logDir = join(ctxRoot, 'logs', agentName);
  const inboundPath = join(logDir, 'inbound-messages.jsonl');
  const outboundPath = join(logDir, 'outbound-messages.jsonl');
  const chatIdStr = String(chatId);

  interface Entry { ts: string; speaker: string; text: string; }
  const entries: Entry[] = [];

  const readLines = (filePath: string, speaker: string) => {
    if (!existsSync(filePath)) return;
    try {
      const raw = readFileSync(filePath, 'utf-8').trim();
      if (!raw) return;
      const lines = raw.split('\n').filter(Boolean);
      const tail = lines.slice(-(limit * 2));
      for (const line of tail) {
        try {
          const obj = JSON.parse(line);
          if (String(obj.chat_id) !== chatIdStr) continue;
          const text = (obj.text || '').trim();
          if (!text) continue;
          entries.push({ ts: obj.timestamp || obj.archived_at || '', speaker, text });
        } catch { /* skip malformed */ }
      }
    } catch { /* skip unreadable */ }
  };

  readLines(inboundPath, process.env.ADMIN_USERNAME ?? 'user');
  readLines(outboundPath, agentName);

  if (entries.length === 0) return null;

  entries.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const recent = entries.slice(-limit);

  const formatted = recent.map(e => {
    const preview = e.text.length > 200 ? e.text.slice(0, 200) + '...' : e.text;
    return '[' + e.speaker + ']: ' + preview;
  });

  return formatted.join('\n');
}
