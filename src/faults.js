// faults.js — the disasters Tornado can inject into the model traffic your agent
// depends on. Each fault is deliberately one of the real failures that break AI
// agents in the wild (measured, not imagined):
//
//   tool_blackout    the tools vanish from the request — does the agent notice,
//                    or fabricate a result? (Ollama silently drops tool defs when
//                    it truncates an over-long prompt; agents then invent tool output.)
//   context_truncate the prompt is cut to a budget, middle dropped — the exact
//                    Ollama truncation that makes local models fabricate.
//   naked_tool_call  a structured tool call in the reply is rewritten AS TEXT —
//                    the "naked tool call" local models emit; does the agent's
//                    parser recover it or drop the action?
//   garble_json      tool-call arguments become invalid JSON — does the agent
//                    crash, retry, or misfire?
//   latency          the reply is delayed — does the agent time out / double-send?
//   http_error       the model returns 500/429 — does the agent degrade or die?
//
// Injectors are pure over (payload, rng) so a run is reproducible from a seed and
// every fault is unit-testable without a network.

/** Deterministic RNG (mulberry32) so a --seed reproduces a run exactly. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const approx = (s) => Math.ceil(String(s || '').length / 4);   // ~4 chars/token

// ── request-side faults (mutate the outgoing chat request) ───────────────────

/** Remove the tool definitions so the model cannot make a structured call. */
export function toolBlackout(req) {
  if (!req.tools?.length) return { applied: false };
  const n = req.tools.length;
  delete req.tools; delete req.tool_choice;
  return { applied: true, detail: `stripped ${n} tool definition(s)` };
}

/**
 * Truncate the prompt to `keepTokens`, keeping the system message and the tail
 * (what Ollama actually does: first tokens + end, middle dropped). Tool
 * definitions ride along in the request, so this also models tools being lost.
 */
export function contextTruncate(req, keepTokens) {
  const msgs = req.messages || [];
  if (!msgs.length) return { applied: false };
  const budget = keepTokens || 2048;
  const total = msgs.reduce((n, m) => n + approx(typeof m.content === 'string' ? m.content : JSON.stringify(m.content)), 0);
  if (total <= budget) return { applied: false, detail: `prompt ~${total} tok already within ${budget}` };
  const head = msgs[0]?.role === 'system' ? [msgs[0]] : [];
  const rest = msgs.slice(head.length);
  const kept = [];
  let used = head.reduce((n, m) => n + approx(m.content), 0);
  for (let i = rest.length - 1; i >= 0; i--) {           // keep from the tail
    const t = approx(typeof rest[i].content === 'string' ? rest[i].content : JSON.stringify(rest[i].content));
    if (used + t > budget) break;
    used += t; kept.unshift(rest[i]);
  }
  req.messages = [...head, ...kept];
  return { applied: true, detail: `dropped ${msgs.length - req.messages.length} message(s), ~${total}→~${used} tok` };
}

// ── response-side faults (mutate the model's reply; non-streaming) ───────────

/** Rewrite a structured tool call as plain text in the content ("naked call"). */
export function nakedToolCall(resp) {
  const m = resp?.choices?.[0]?.message;
  const tc = m?.tool_calls?.[0];
  if (!tc) return { applied: false };
  const name = tc.function?.name;
  const args = tc.function?.arguments || '{}';
  m.content = `${m.content ? m.content + '\n' : ''}<tool_call>\n${JSON.stringify({ name, arguments: typeof args === 'string' ? safeParse(args) : args })}\n</tool_call>`;
  delete m.tool_calls;
  if (resp.choices[0].finish_reason === 'tool_calls') resp.choices[0].finish_reason = 'stop';
  return { applied: true, detail: `tool call '${name}' rewritten as text` };
}
const safeParse = (s) => { try { return JSON.parse(s); } catch { return s; } };

/** Corrupt tool-call arguments into invalid JSON. */
export function garbleJson(resp) {
  const tc = resp?.choices?.[0]?.message?.tool_calls?.[0];
  if (!tc?.function) return { applied: false };
  tc.function.arguments = String(tc.function.arguments || '{}').replace(/}\s*$/, '');  // drop the closing brace
  return { applied: true, detail: `arguments of '${tc.function.name}' truncated to invalid JSON` };
}

// ── the plan: decide which faults fire this call, from config + rng ──────────

export const FAULTS = ['tool_blackout', 'context_truncate', 'naked_tool_call', 'garble_json', 'latency', 'http_error'];

/**
 * Given a config { fault: {p, ...opts} } and an rng, return the faults that fire.
 * Each has a probability p (0..1). Returns [{name, opts}].
 */
export function plan(config, rand) {
  const fired = [];
  for (const name of FAULTS) {
    const c = config[name];
    if (!c) continue;
    const p = typeof c === 'number' ? c : (c.p ?? 1);
    if (rand() < p) fired.push({ name, opts: typeof c === 'object' ? c : {} });
  }
  return fired;
}
