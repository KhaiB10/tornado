// server.js — the proxy. Point your agent at Tornado instead of the model API;
// Tornado passes calls through but injects the configured faults, and records
// what it broke so you can see how your agent coped.
import http from 'node:http';
import { rng, plan, toolBlackout, contextTruncate, nakedToolCall, garbleJson } from './faults.js';

const HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-length', 'host', 'upgrade']);
const readBody = (req) => new Promise((res, rej) => { const c = []; req.on('data', x => c.push(x)); req.on('end', () => res(Buffer.concat(c))); req.on('error', rej); });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function sendJson(res, status, obj, headers = {}) {
  const b = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b), ...headers });
  res.end(b);
}

export function createTornado(opts = {}) {
  const cfg = {
    upstream: opts.upstream || 'http://127.0.0.1:11434',
    config: opts.config || {},
    log: opts.log || ((e) => console.log(`[tornado] ${JSON.stringify(e)}`)),
  };
  let seq = 0;
  const rand = rng(opts.seed ?? ((Math.random() * 2 ** 31) | 0));
  const report = { started: new Date().toISOString(), calls: 0, injected: {}, events: [] };
  const bump = (name) => { report.injected[name] = (report.injected[name] || 0) + 1; };

  const server = http.createServer(async (req, res) => {
    const raw = await readBody(req).catch(() => Buffer.alloc(0));
    const path = new URL(req.url, 'http://x').pathname;
    const isChat = req.method === 'POST' && /\/chat\/completions$/.test(path);

    // Everything that isn't a chat completion passes straight through untouched.
    if (!isChat) return passthrough(req, res, raw, cfg);

    let body; try { body = JSON.parse(raw.toString('utf8') || '{}'); } catch { return sendJson(res, 400, { error: { message: 'tornado: invalid JSON' } }); }
    report.calls++; seq++;
    const fired = plan(cfg.config, rand);
    const applied = [];

    // request-side faults
    for (const f of fired) {
      if (f.name === 'tool_blackout') { const r = toolBlackout(body); if (r.applied) { applied.push({ fault: 'tool_blackout', ...r }); bump('tool_blackout'); } }
      if (f.name === 'context_truncate') { const r = contextTruncate(body, f.opts.keep_tokens); if (r.applied) { applied.push({ fault: 'context_truncate', ...r }); bump('context_truncate'); } }
    }
    const errFault = fired.find(f => f.name === 'http_error');
    const latFault = fired.find(f => f.name === 'latency');
    if (latFault) { const ms = latFault.opts.ms ?? 30000; await sleep(ms); applied.push({ fault: 'latency', detail: `delayed ${ms}ms` }); bump('latency'); }
    if (errFault) {
      const code = errFault.opts.code ?? 500;
      applied.push({ fault: 'http_error', detail: `returned ${code}` }); bump('http_error');
      logEvent(cfg, report, seq, body.model, applied, streamAsked(body));
      return sendJson(res, code, { error: { message: `tornado: injected HTTP ${code}`, type: code === 429 ? 'rate_limit' : 'server_error' } });
    }

    // forward to the real model
    let up;
    try {
      up = await fetch(new URL('/v1/chat/completions', cfg.upstream), {
        method: 'POST', headers: { 'content-type': 'application/json', ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}) },
        body: JSON.stringify(body),
      });
    } catch (e) { return sendJson(res, 502, { error: { message: `tornado: upstream unreachable: ${e.message}` } }); }

    const streaming = /text\/event-stream/.test(up.headers.get('content-type') || '') || body.stream;
    const respFaults = fired.filter(f => ['naked_tool_call', 'garble_json'].includes(f.name));

    // Streaming: pass bytes through (response-mutation faults apply to
    // non-streaming only; request-side faults + latency + http_error already fired).
    if (streaming || !up.headers.get('content-type')?.includes('json')) {
      const outh = {}; up.headers.forEach((v, k) => { if (!HOP.has(k)) outh[k] = v; });
      res.writeHead(up.status, outh);
      if (up.body) for await (const ch of up.body) res.write(ch);
      res.end();
      logEvent(cfg, report, seq, body.model, applied, true);
      return;
    }

    const resp = await up.json();
    for (const f of respFaults) {
      if (f.name === 'naked_tool_call') { const r = nakedToolCall(resp); if (r.applied) { applied.push({ fault: 'naked_tool_call', ...r }); bump('naked_tool_call'); } }
      if (f.name === 'garble_json') { const r = garbleJson(resp); if (r.applied) { applied.push({ fault: 'garble_json', ...r }); bump('garble_json'); } }
    }
    logEvent(cfg, report, seq, body.model, applied, false);
    sendJson(res, up.status, resp, applied.length ? { 'x-tornado-injected': applied.map(a => a.fault).join(',') } : {});
  });

  server.report = () => report;
  return server;
}

function streamAsked(body) { return !!body.stream; }
function logEvent(cfg, report, seq, model, applied, streaming) {
  const e = { call: seq, model, streaming, injected: applied };
  if (applied.length) { report.events.push(e); cfg.log(e); }
}

async function passthrough(req, res, raw, cfg) {
  const headers = {}; for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) headers[k] = v;
  let up;
  try { up = await fetch(new URL(req.url, cfg.upstream), { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : raw, duplex: 'half' }); }
  catch (e) { return sendJson(res, 502, { error: { message: `tornado: upstream unreachable: ${e.message}` } }); }
  const out = {}; up.headers.forEach((v, k) => { if (!HOP.has(k)) out[k] = v; });
  res.writeHead(up.status, out);
  if (up.body) for await (const ch of up.body) res.write(ch);
  res.end();
}
