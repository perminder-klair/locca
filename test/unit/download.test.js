import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { downloadUrl, sha256File } from '../../dist/hf.js';

const PAYLOAD = Buffer.from('0123456789abcdef'.repeat(4096)); // 64 KiB

// Minimal file server with configurable Range behaviour per path:
//   /file        — honours Range (206)
//   /no-range    — ignores Range, always sends the full body (200)
//   /truncated   — advertises the full length but sends half and hangs up
let server;
let base;

before(async () => {
  server = createServer((req, res) => {
    const range = req.headers.range?.match(/^bytes=(\d+)-$/);
    if (req.url === '/file' && range) {
      const start = parseInt(range[1], 10);
      if (start >= PAYLOAD.length) {
        res.writeHead(416, { 'content-range': `bytes */${PAYLOAD.length}` });
        res.end();
        return;
      }
      const body = PAYLOAD.subarray(start);
      res.writeHead(206, {
        'content-length': body.length,
        'content-range': `bytes ${start}-${PAYLOAD.length - 1}/${PAYLOAD.length}`,
      });
      res.end(body);
      return;
    }
    if (req.url === '/truncated') {
      // Advertise the full length but close after half — the client sees a
      // clean connection close with a short body (a dropped transfer).
      res.writeHead(200, { 'content-length': PAYLOAD.length });
      res.end(PAYLOAD.subarray(0, PAYLOAD.length / 2));
      return;
    }
    // /file without Range, or /no-range with Range ignored.
    res.writeHead(200, { 'content-length': PAYLOAD.length });
    res.end(PAYLOAD);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

const freshDest = () => join(mkdtempSync(join(tmpdir(), 'locca-dl-')), 'model.gguf');

test('fresh download lands atomically with progress', async () => {
  const dest = freshDest();
  const seen = [];
  await downloadUrl(`${base}/file`, dest, (got, total) => seen.push([got, total]));
  assert.ok(readFileSync(dest).equals(PAYLOAD));
  assert.ok(!existsSync(`${dest}.part`), '.part must be renamed away');
  assert.equal(seen.at(-1)[0], PAYLOAD.length);
  assert.equal(seen.at(-1)[1], PAYLOAD.length);
});

test('a leftover .part resumes from its offset', async () => {
  const dest = freshDest();
  const offset = 10000;
  writeFileSync(`${dest}.part`, PAYLOAD.subarray(0, offset));
  let firstGot;
  await downloadUrl(`${base}/file`, dest, (got) => {
    firstGot ??= got;
  });
  assert.ok(firstGot > offset, `progress should start past the resume offset (got ${firstGot})`);
  assert.ok(readFileSync(dest).equals(PAYLOAD));
});

test('a .part that already holds the whole file is published via 416', async () => {
  const dest = freshDest();
  writeFileSync(`${dest}.part`, PAYLOAD);
  await downloadUrl(`${base}/file`, dest);
  assert.ok(readFileSync(dest).equals(PAYLOAD));
});

test('a server that ignores Range restarts cleanly from zero', async () => {
  const dest = freshDest();
  writeFileSync(`${dest}.part`, Buffer.from('stale-different-bytes'));
  await downloadUrl(`${base}/no-range`, dest);
  assert.ok(readFileSync(dest).equals(PAYLOAD), 'stale partial content must not survive');
});

test('a short read throws and keeps the .part for resume', async () => {
  const dest = freshDest();
  await assert.rejects(() => downloadUrl(`${base}/truncated`, dest));
  assert.ok(!existsSync(dest), 'truncated file must not be published');
  assert.ok(existsSync(`${dest}.part`), '.part should remain for the next attempt');
  assert.ok(statSync(`${dest}.part`).size < PAYLOAD.length);
});

test('sha256File matches a known digest', async () => {
  const dest = freshDest();
  writeFileSync(dest, 'hello world');
  assert.equal(
    await sha256File(dest),
    'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
  );
});
