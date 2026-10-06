import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, explainWithModel } from '../server.js';
import { analyzeScenario } from '../public/core/engine.js';

test('HTTP server exposes demo and protects private paths', async () => {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const home = await fetch(origin);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /Know the impact/);
    assert.match(home.headers.get('content-security-policy'), /script-src 'self'/);
    assert.deepEqual(await (await fetch(`${origin}/healthz`)).json(), { status: 'ok' });
    const scenarios = await (await fetch(`${origin}/api/scenarios`)).json();
    assert.equal(scenarios.length, 4);
    assert.equal((await fetch(`${origin}/%2e%2e/server.js`)).status, 404);
    assert.equal((await fetch(`${origin}/api/ai/explain`, { method: 'POST' })).status, 503);
    assert.equal((await fetch(`${origin}/api/ai/propose`, { method: 'POST' })).status, 503);
    const lab = await fetch(`${origin}/labs/frr/lab.json`);
    assert.equal(lab.status, 200);
    assert.match(lab.headers.get('content-type'), /application\/json/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('AI adapter sends bounded deterministic evidence and handles provider output', async () => {
  const result = await explainWithModel(analyzeScenario('policy-drift'), {
    key: 'test-only', model: 'stub-model',
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.openai.com/v1/responses');
      const body = JSON.parse(options.body);
      assert.equal(body.max_output_tokens, 450);
      assert.equal(body.store, false);
      assert.match(body.input, /INT-04/);
      assert.doesNotMatch(body.input, /test-only/);
      return { ok: true, json: async () => ({ output: [{ content: [{ type: 'output_text', text: 'INT-04 is exposed. Review the edge ACL.' }] }] }) };
    }
  });
  assert.match(result.text, /INT-04/);
  assert.equal(result.model, 'stub-model');
});
