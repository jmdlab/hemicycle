import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { downloadResumable } from '../server/data/download.mjs';

/** A server that, like the AN host, drops each response after `cut` bytes, and honours Range + If-Range. */
function flakyServer({ body, etag = '"v1"', cut = 50_000, ranges = true }) {
  const state = { requests: 0, etag, body };
  const srv = http.createServer((req, res) => {
    state.requests++;
    let start = 0;
    const m = /^bytes=(\d+)-$/.exec(req.headers.range || '');
    const sameVersion = !req.headers['if-range'] || req.headers['if-range'] === state.etag;
    if (ranges && m && sameVersion) start = Number(m[1]);
    const part = state.body.subarray(start);
    const headers = { ETag: state.etag, 'Content-Length': part.length, 'Accept-Ranges': 'bytes' };
    if (start > 0) {
      headers['Content-Range'] = `bytes ${start}-${state.body.length - 1}/${state.body.length}`;
      res.writeHead(206, headers);
    } else res.writeHead(200, headers);
    res.write(part.subarray(0, cut), () => {
      if (part.length > cut) res.socket.destroy();
      else res.end();
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, state, url: `http://127.0.0.1:${srv.address().port}/f.zip` })));
}

test('resumes a download the server keeps cutting, byte for byte', async () => {
  const body = crypto.randomBytes(300_000);
  const { srv, state, url } = await flakyServer({ body });
  try {
    const got = await downloadResumable(url, { backoffMs: 1 });
    assert.equal(got.buf.length, body.length);
    assert.ok(got.buf.equals(body));
    assert.equal(got.etag, '"v1"');
    assert.ok(state.requests >= 6, `expected several resumed requests, got ${state.requests}`);
  } finally {
    srv.close();
  }
});

test('a single plain fetch fails on the same server (the bug this fixes)', async () => {
  const body = crypto.randomBytes(300_000);
  const { srv, url } = await flakyServer({ body });
  try {
    await assert.rejects(async () => Buffer.from(await (await fetch(url)).arrayBuffer()));
  } finally {
    srv.close();
  }
});

test('restarts from zero when the file changes between attempts (If-Range miss)', async () => {
  const v1 = crypto.randomBytes(200_000);
  const v2 = crypto.randomBytes(120_000);
  const { srv, state, url } = await flakyServer({ body: v1 });
  try {
    let n = 0;
    const got = await downloadResumable(url, {
      backoffMs: 1,
      fetchImpl: async (u, o) => {
        if (++n === 2) Object.assign(state, { body: v2, etag: '"v2"' }); // publish a new version mid-download
        return fetch(u, o);
      },
    });
    assert.ok(got.buf.equals(v2));
    assert.equal(got.etag, '"v2"');
  } finally {
    srv.close();
  }
});

test('gives up with a clear error when the budget runs out', async () => {
  const body = crypto.randomBytes(300_000);
  const { srv, url } = await flakyServer({ body, ranges: false });
  try {
    await assert.rejects(downloadResumable(url, { attempts: 3, backoffMs: 1 }), /incomplet après 3 tentatives/);
  } finally {
    srv.close();
  }
});

test('accept() can decline a stale copy without reading it', async () => {
  const body = crypto.randomBytes(300_000);
  const { srv, url } = await flakyServer({ body });
  try {
    const got = await downloadResumable(url, { backoffMs: 1, accept: () => false });
    assert.equal(got.buf, null);
    assert.equal(got.etag, '"v1"');
  } finally {
    srv.close();
  }
});

test('a body that arrives whole needs one request', async () => {
  const body = crypto.randomBytes(10_000);
  const { srv, state, url } = await flakyServer({ body });
  try {
    const got = await downloadResumable(url, { backoffMs: 1 });
    assert.ok(got.buf.equals(body));
    assert.equal(state.requests, 1);
  } finally {
    srv.close();
  }
});
