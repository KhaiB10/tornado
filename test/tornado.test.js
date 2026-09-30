import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { rng, plan, toolBlackout, contextTruncate, nakedToolCall, garbleJson } from '../src/faults.js';
import { createTornado } from '../src/server.js';

const TOOLS = [{ type: 'function', function: { name: 'bash', parameters: {} } }];
const req = () => ({ model: 'm', tools: [...TOOLS], messages: [
  { role: 'system', content: 'You are helpful.' },
  { role: 'user', content: 'x'.repeat(400) },
  { role: 'assistant', content: 'y'.repeat(400) },
  { role: 'user', content: 'the latest and most important question' },
] });
const respWithCall = () => ({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'c', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }] }, finish_reason: 'tool_calls' }] });

describe('faults are deterministic and correct', () => {
  test('rng is reproducible from a seed', () => {
    const a = rng(42), b = rng(42);
    assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
  });
  test('plan fires a p=1 fault and skips a p=0 fault', () => {
    const fired = plan({ tool_blackout: 1, http_error: 0 }, rng(1)).map(f => f.name);
    assert.ok(fired.includes('tool_blackout'));
    assert.ok(!fired.includes('http_error'));
  });
  test('tool_blackout removes the tool definitions', () => {
    const r = req(); assert.equal(toolBlackout(r).applied, true); assert.equal(r.tools, undefined);
    assert.equal(toolBlackout({ messages: [] }).applied, false);
  });
  test('context_truncate keeps the system message and the tail, drops the middle', () => {
    const r = req(); const out = contextTruncate(r, 120);
    assert.equal(out.applied, true);
    assert.equal(r.messages[0].role, 'system');
    assert.equal(r.messages[r.messages.length - 1].content, 'the latest and most important question');
    assert.ok(r.messages.length < 4, 'a message was dropped');
  });
  test('naked_tool_call turns a structured call into text and clears tool_calls', () => {
    const resp = respWithCall(); assert.equal(nakedToolCall(resp).applied, true);
    const m = resp.choices[0].message;
    assert.equal(m.tool_calls, undefined);
    assert.match(m.content, /<tool_call>[\s\S]*bash[\s\S]*ls/);
    assert.equal(resp.choices[0].finish_reason, 'stop');
  });
  test('garble_json makes the arguments invalid JSON', () => {
    const resp = respWithCall(); garbleJson(resp);
    assert.throws(() => JSON.parse(resp.choices[0].message.tool_calls[0].function.arguments));
  });
});

describe('proxy end to end', () => {
  let up, tor, base, lastReq;
  before(async () => {
    up = http.createServer(async (r, s) => {
      let b = ''; for await (const c of r) b += c;
      lastReq = b ? JSON.parse(b) : {};
      s.writeHead(200, { 'content-type': 'application/json' });
      s.end(JSON.stringify(respWithCall()));
    });
    await new Promise(r => up.listen(0, '127.0.0.1', r));
  });
  after(() => up.close());
  const start = (config, seed = 1) => new Promise(r => {
    tor = createTornado({ upstream: `http://127.0.0.1:${up.address().port}`, config, seed, log: () => {} });
    tor.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${tor.address().port}`; r(); });
  });
  const post = (body) => fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  test('tool_blackout: the upstream receives a request with no tools', async () => {
    await start({ tool_blackout: 1 });
    const r = await post(req());
    assert.equal(r.status, 200);
    assert.equal(lastReq.tools, undefined, 'tools were stripped before reaching the model');
    assert.equal(r.headers.get('x-tornado-injected'), 'tool_blackout');
    tor.close();
  });
  test('naked_tool_call: the client gets text instead of a structured call', async () => {
    await start({ naked_tool_call: 1 });
    const j = await (await post(req())).json();
    assert.equal(j.choices[0].message.tool_calls, undefined);
    assert.match(j.choices[0].message.content, /<tool_call>/);
    tor.close();
  });
  test('http_error: the model call is replaced with an injected 429', async () => {
    await start({ http_error: { p: 1, code: 429 } });
    const r = await post(req());
    assert.equal(r.status, 429);
    assert.equal((await r.json()).error.type, 'rate_limit');
    tor.close();
  });
  test('no faults configured to fire: the reply passes through intact, report counts it', async () => {
    await start({ http_error: 0 });
    const j = await (await post(req())).json();
    assert.equal(j.choices[0].message.tool_calls[0].function.name, 'bash');
    assert.equal(tor.report().calls, 1);
    tor.close();
  });
});
