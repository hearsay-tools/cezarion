'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { reader } = require('./queue-ci-proof.cjs');

for (const remaining of [60000, 25]) {
  // bound: the loopback server receiving the request triggers cancellation;
  // this timeout only guards a hung connection or server shutdown.
  test(`request cancellation enforces the ${Math.min(10000, remaining)}ms deadline through fetch`, { timeout: 10000 }, async t => {
    const controller = new AbortController();
    t.mock.method(AbortSignal, 'timeout', ms => {
      assert.equal(ms, Math.min(10000, remaining));
      return controller.signal;
    });
    const server = createServer((_req, res) => {
      // The real fetch has started. Numeric request.timeout is ignored by
      // github-script v9; its fetch wrapper forwards only request.signal.
      controller.abort(new DOMException('request deadline', 'TimeoutError'));
      res.end(JSON.stringify({ accepted: true }));
    });
    t.after(async () => {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const url = `http://127.0.0.1:${server.address().port}`;
    const github = { request: async (_route, options) => {
      const response = await fetch(url, { signal: options.request.signal });
      return { data: await response.json() };
    } };
    await assert.rejects(() => reader(github, 'o', 'r', remaining, () => 0)('GET /test'), { name: 'TimeoutError' });
  });
}

test('a write and a GraphQL mutation run once, even on a 5xx', async () => {
  for (const [route, args] of [['POST /repos/{owner}/{repo}/actions/jobs/{job_id}/rerun', { job_id: 1 }],
    ['POST /graphql', { query: ' mutation { resolveReviewThread(input: {}) { clientMutationId } }' }],
    ['POST /graphql', { query: '# query comes first\nmutation { resolveReviewThread(input: {}) { clientMutationId } }' }]]) {
    let calls = 0;
    const github = { request: async () => { calls++; throw Object.assign(new Error('Bad Gateway'), { status: 502 }); } };
    await assert.rejects(() => reader(github, 'o', 'r', 60000, () => 0, async () => assert.fail('no retry'))(route, args), /Bad Gateway/);
    assert.equal(calls, 1, args.query ?? route);
  }
});

test('a GraphQL query, after blanks and comments, is a read that is retried', async () => {
  for (const query of ['query($n: Int!) { x }', '\n  # first ready\n{ x }']) {
    let calls = 0;
    const github = { request: async () => { if (++calls === 1) throw Object.assign(new Error('Bad Gateway'), { status: 502 }); return { data: 'ok' }; } };
    assert.equal(await reader(github, 'o', 'r', 60000, () => 0, async () => {})('POST /graphql', { query }), 'ok');
    assert.equal(calls, 2, query);
  }
});
