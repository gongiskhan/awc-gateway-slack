#!/usr/bin/env node
'use strict';

const http = require('http');
const { randomUUID } = require('crypto');

const PORT = Number(process.env.PORT || 9511);

const pending = [];
const subscribers = new Set();

const log = (...args) => console.error('[gateway]', ...args);

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function broadcast(event) {
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of subscribers) {
    try {
      res.write(line);
    } catch (err) {
      log('broadcast write failed', err.message);
      subscribers.delete(res);
    }
  }
}

async function handleInbound(req, res) {
  const body = await readBody(req);
  const { from, text, reply_to } = body;
  if (typeof from !== 'string' || typeof text !== 'string' || typeof reply_to !== 'string') {
    return sendJson(res, 400, { error: 'from, text, reply_to required (strings)' });
  }
  const id = randomUUID();
  const item = { id, from, text, reply_to };
  pending.push(item);
  process.stdout.write(`INBOUND ${JSON.stringify(item)}\n`);
  sendJson(res, 202, { id });
}

async function handleOutbound(req, res) {
  const body = await readBody(req);
  const { text } = body;
  if (typeof text !== 'string') {
    return sendJson(res, 400, { error: 'text required (string)' });
  }
  const head = pending.shift();
  if (!head) {
    log('outbound received with empty queue; dropping');
    return sendJson(res, 200, { paired: false });
  }
  const event = { id: head.id, reply_to: head.reply_to, text };
  broadcast(event);
  sendJson(res, 200, { paired: true, id: head.id });
}

function handleEvents(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  subscribers.add(res);
  log(`subscriber connected (${subscribers.size} total)`);

  const keepalive = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch (err) {
      clearInterval(keepalive);
    }
  }, 25_000);

  const cleanup = () => {
    clearInterval(keepalive);
    if (subscribers.delete(res)) {
      log(`subscriber disconnected (${subscribers.size} total)`);
    }
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/inbound') return await handleInbound(req, res);
    if (req.method === 'POST' && req.url === '/outbound') return await handleOutbound(req, res);
    if (req.method === 'GET' && req.url === '/events') return handleEvents(req, res);
    if (req.method === 'GET' && req.url === '/health') return sendJson(res, 200, { ok: true, pending: pending.length, subscribers: subscribers.size });
    sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    log('handler error', err.message);
    if (!res.headersSent) sendJson(res, 500, { error: err.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  log(`listening on http://127.0.0.1:${PORT}`);
});

const shutdown = (signal) => {
  log(`received ${signal}, shutting down`);
  for (const res of subscribers) {
    try { res.end(); } catch {}
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
