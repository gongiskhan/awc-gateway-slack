#!/usr/bin/env node
'use strict';

// Slack channel adapter for the AWC gateway.
//
// Inbound:  POST /slack/events  (Slack Events API webhook)
//   - Verifies Slack signature.
//   - Handles url_verification challenges.
//   - For app_mention events, POSTs to the gateway's /inbound.
//
// Outbound: SSE subscriber on the gateway's /events.
//   - Decodes reply_to ("slack:<channel>:<thread_ts>") and calls
//     chat.postMessage on Slack's Web API.
//   - Retries on 429 / 5xx / connection errors with capped backoff.

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || '';
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || '';
const GATEWAY_URL = process.env.GATEWAY_URL || 'http://127.0.0.1:9511';
const SLACK_PORT = Number(process.env.SLACK_PORT || 9512);

if (!SLACK_BOT_TOKEN || !SLACK_SIGNING_SECRET) {
  console.error('[slack] SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET are required');
  process.exit(1);
}

const log = (...args) => console.error('[slack]', ...args);

// ---------------------------------------------------------------------------
// Slack signature verification
// ---------------------------------------------------------------------------

function verifySlackSignature(headers, rawBody) {
  const ts = headers['x-slack-request-timestamp'];
  const sig = headers['x-slack-signature'];
  if (!ts || !sig) return false;
  const age = Math.abs(Date.now() / 1000 - Number(ts));
  if (!Number.isFinite(age) || age > 300) return false; // 5-min replay guard
  const base = `v0:${ts}:${rawBody}`;
  const expected = 'v0=' + crypto
    .createHmac('sha256', SLACK_SIGNING_SECRET)
    .update(base)
    .digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 2_000_000) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendText(res, status, body, type = 'text/plain') {
  const payload = Buffer.from(body);
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': payload.length });
  res.end(payload);
}

function postJson(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = Buffer.from(JSON.stringify(body));
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        method: 'POST',
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': payload.length,
          ...headers,
        },
        timeout: 10_000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode || 0, headers: res.headers, body: text });
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('request timeout'));
    });
    req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Slack Web API: chat.postMessage with retry
// ---------------------------------------------------------------------------

async function chatPostMessage({ channel, thread_ts, text }, attempt = 0) {
  const res = await postJson(
    'https://slack.com/api/chat.postMessage',
    { channel, thread_ts, text },
    { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
  ).catch((err) => ({ error: err }));

  if (res.error) {
    if (attempt < 3) {
      const wait = 500 * Math.pow(2, attempt);
      log(`chat.postMessage network error, retrying in ${wait}ms:`, res.error.message);
      await new Promise((r) => setTimeout(r, wait));
      return chatPostMessage({ channel, thread_ts, text }, attempt + 1);
    }
    log('chat.postMessage gave up after network failures');
    return false;
  }

  if (res.status === 429) {
    const retryAfter = Number(res.headers['retry-after'] || 1);
    if (attempt < 5) {
      log(`chat.postMessage 429, retrying in ${retryAfter}s`);
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      return chatPostMessage({ channel, thread_ts, text }, attempt + 1);
    }
    log('chat.postMessage gave up after 429s');
    return false;
  }

  if (res.status >= 500 && attempt < 3) {
    const wait = 500 * Math.pow(2, attempt);
    log(`chat.postMessage ${res.status}, retrying in ${wait}ms`);
    await new Promise((r) => setTimeout(r, wait));
    return chatPostMessage({ channel, thread_ts, text }, attempt + 1);
  }

  let parsed;
  try { parsed = JSON.parse(res.body); } catch { parsed = null; }
  if (!parsed || parsed.ok !== true) {
    log(`chat.postMessage failed: status=${res.status} body=${res.body.slice(0, 300)}`);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Slack inbound: app_mention and DM handling
// ---------------------------------------------------------------------------

function stripMention(text) {
  // Remove leading <@U123456> mention tokens (potentially with surrounding space).
  return text.replace(/^\s*(<@[UW][A-Z0-9]+>\s*)+/i, '').trim();
}

async function forwardToGateway({ user, text, channel, thread_ts }) {
  const reply_to = `slack:${channel}:${thread_ts}`;
  const res = await postJson(`${GATEWAY_URL}/inbound`, {
    from: `slack:${user}`,
    text,
    reply_to,
  }).catch((err) => ({ error: err }));
  if (res.error || (res.status !== 202 && res.status !== 200)) {
    log(`gateway /inbound failed: ${res.error ? res.error.message : res.status}`);
    return false;
  }
  return true;
}

async function handleSlackEvent(parsed) {
  const event = parsed.event;
  if (!event) return;
  if (event.subtype === 'bot_message' || event.bot_id) return; // ignore bot echoes

  if (event.type === 'app_mention' || (event.type === 'message' && event.channel_type === 'im')) {
    const text = stripMention(event.text || '');
    if (!text) return;
    const thread_ts = event.thread_ts || event.ts;
    await forwardToGateway({
      user: event.user,
      text,
      channel: event.channel,
      thread_ts,
    });
  }
}

// ---------------------------------------------------------------------------
// SSE subscriber for outbound replies
// ---------------------------------------------------------------------------

function subscribeToGateway() {
  const u = new URL(`${GATEWAY_URL}/events`);
  const lib = u.protocol === 'https:' ? https : http;
  let buffer = '';

  const req = lib.request(
    {
      method: 'GET',
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers: { Accept: 'text/event-stream' },
    },
    (res) => {
      if (res.statusCode !== 200) {
        log(`SSE connect failed: status ${res.statusCode}`);
        res.resume();
        scheduleReconnect();
        return;
      }
      log('SSE connected to gateway');
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        let idx;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          processFrame(frame);
        }
      });
      res.on('end', () => {
        log('SSE stream ended');
        scheduleReconnect();
      });
      res.on('error', (err) => {
        log('SSE stream error:', err.message);
        scheduleReconnect();
      });
    },
  );
  req.on('error', (err) => {
    log('SSE connect error:', err.message);
    scheduleReconnect();
  });
  req.end();
}

let reconnectDelay = 500;
let reconnectTimer = null;
function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    subscribeToGateway();
  }, delay);
}

function processFrame(frame) {
  const dataLines = frame
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => l.slice(6));
  if (dataLines.length === 0) return; // comment / keepalive
  reconnectDelay = 500; // reset on any real frame
  const raw = dataLines.join('\n');
  let event;
  try { event = JSON.parse(raw); }
  catch (err) { log('bad SSE frame:', err.message); return; }

  const { reply_to, text } = event || {};
  if (typeof reply_to !== 'string' || typeof text !== 'string') {
    log('SSE frame missing reply_to/text');
    return;
  }
  const parts = reply_to.split(':');
  if (parts[0] !== 'slack' || parts.length < 3) {
    // Not for us.
    return;
  }
  const channel = parts[1];
  const thread_ts = parts.slice(2).join(':');
  if (!text) {
    // Hook always POSTs (even on empty text) to keep the gateway's pending
    // queue aligned with inbounds. Don't spam Slack with blank messages.
    log(`skipping empty reply for ${reply_to}`);
    return;
  }
  chatPostMessage({ channel, thread_ts, text }).catch((err) => {
    log('chat.postMessage threw:', err.message);
  });
}

// ---------------------------------------------------------------------------
// HTTP server for Slack webhooks
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      return sendText(res, 200, 'ok\n');
    }
    if (req.method !== 'POST' || req.url !== '/slack/events') {
      return sendText(res, 404, 'not found\n');
    }

    const raw = await readRaw(req);
    if (!verifySlackSignature(req.headers, raw)) {
      log('rejected: bad signature');
      return sendText(res, 401, 'bad signature\n');
    }

    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { return sendText(res, 400, 'bad json\n'); }

    if (parsed.type === 'url_verification') {
      return sendText(res, 200, parsed.challenge || '');
    }

    // Respond immediately so Slack does not retry; process event async.
    sendText(res, 200, 'ok\n');
    handleSlackEvent(parsed).catch((err) => log('handleSlackEvent threw:', err.message));
  } catch (err) {
    log('handler error:', err.message);
    if (!res.headersSent) sendText(res, 500, 'error\n');
  }
});

server.listen(SLACK_PORT, '127.0.0.1', () => {
  log(`webhook listening on http://127.0.0.1:${SLACK_PORT}/slack/events`);
  subscribeToGateway();
});

const shutdown = (signal) => {
  log(`received ${signal}, shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
