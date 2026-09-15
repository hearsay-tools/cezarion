const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { setImmediate } = require('node:timers/promises');

test('browser test fetch closes each connection and preserves Request method, headers and body', async () => {
  await import('../../packages/web/e2e/fetch-setup.mjs');
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ socket: req.socket, method: req.method, header: req.headers['x-test'], body, connection: req.headers.connection });
    res.end('ok');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    for (let i = 0; i < 2; i++) {
      const request = new Request(url, { method: 'POST', headers: { 'x-test': 'preserved' }, body: 'payload' });
      assert.equal(await (await fetch(request)).text(), 'ok');
      assert.equal(request.headers.has('connection'), false);
      await setImmediate();
    }
    assert.equal(requests.length, 2);
    for (const request of requests) {
      assert.equal(request.connection, 'close');
      assert.equal(request.method, 'POST');
      assert.equal(request.header, 'preserved');
      assert.equal(request.body, 'payload');
    }
    assert.notEqual(requests[0].socket, requests[1].socket);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
