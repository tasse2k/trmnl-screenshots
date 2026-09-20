'use strict';

// Guards verifyReadback() against the failure seen in run #14010:
// "GET /img/barcelona-next did not send a Content-Length header".
//
// Root cause was in the CHECK, not the server: undici's fetch defaults to
// `accept-encoding: gzip, deflate, br`, transparently decompresses, and drops
// content-length because it no longer describes the decoded body. The TRMNL
// device does not negotiate compression, so the check was failing on a
// response the device never receives.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const zlib = require('node:zlib');

const { verifyReadback } = require('../run.js');

/** Server that honours Accept-Encoding the way a CDN would. */
function startServer(payload, { alwaysGzip = false, omitLength = false } = {}) {
  const seen = {};
  const server = http.createServer((req, res) => {
    seen.acceptEncoding = req.headers['accept-encoding'];
    const wantsGzip = alwaysGzip ||
      /\bgzip\b/.test(req.headers['accept-encoding'] || '');

    if (wantsGzip) {
      // Compressed: a real CDN cannot send the identity length here.
      const gz = zlib.gzipSync(payload);
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Encoding': 'gzip',
        'Content-Length': String(gz.length),
      });
      return res.end(gz);
    }
    const headers = { 'Content-Type': 'image/png' };
    if (!omitLength) headers['Content-Length'] = String(payload.length);
    res.writeHead(200, headers);
    res.end(payload);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, seen, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

const PAYLOAD = Buffer.from('\x89PNG\r\n\x1a\n' + 'x'.repeat(2048), 'binary');

test('requests identity encoding, like the device does', async () => {
  const { server, seen, base } = await startServer(PAYLOAD);
  try {
    await verifyReadback(base, 'barcelona', PAYLOAD);
    assert.match(seen.acceptEncoding, /identity/,
      'must ask for identity so Content-Length survives');
    assert.doesNotMatch(seen.acceptEncoding, /gzip/,
      'must not offer gzip -- undici would decompress and drop content-length');
  } finally { server.close(); }
});

test('passes when bytes and Content-Length match', async () => {
  const { server, base } = await startServer(PAYLOAD);
  try {
    const out = await verifyReadback(base, 'barcelona', PAYLOAD);
    assert.strictEqual(out.contentLength, PAYLOAD.length);
  } finally { server.close(); }
});

test('fails loudly when Content-Length is absent', async () => {
  const { server, base } = await startServer(PAYLOAD, { omitLength: true });
  try {
    await assert.rejects(
      () => verifyReadback(base, 'barcelona', PAYLOAD),
      /did not send a Content-Length header/);
  } finally { server.close(); }
});

test('rejects a compressed response with a diagnostic message', async () => {
  // A server that compresses regardless of Accept-Encoding cannot send the
  // identity length, so this must fail rather than silently pass.
  const { server, base } = await startServer(PAYLOAD, { alwaysGzip: true });
  try {
    await assert.rejects(
      () => verifyReadback(base, 'barcelona', PAYLOAD),
      (err) => /Content-Length|differ/.test(err.message));
  } finally { server.close(); }
});

test('still catches tampered bytes', async () => {
  const other = Buffer.from('\x89PNG\r\n\x1a\n' + 'y'.repeat(2048), 'binary');
  const { server, base } = await startServer(other);
  try {
    await assert.rejects(
      () => verifyReadback(base, 'barcelona', PAYLOAD),
      /differ from uploaded bytes|does not match/);
  } finally { server.close(); }
});
