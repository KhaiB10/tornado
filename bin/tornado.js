#!/usr/bin/env node
import { createTornado } from '../src/server.js';
import { FAULTS } from '../src/faults.js';

const HELP = `tornado — inject real failures into your AI agent's model traffic, and see if it survives.

  tornado --upstream URL [--port 8100] [--seed N] [FAULT=P ...]

Point your agent at http://localhost:8100/v1 instead of the model API, then run
your agent's normal tasks or test suite. Tornado passes calls through but injects
the faults you turn on, and prints a report of what it broke.

Faults (each takes a probability 0..1, applied per call):
  tool_blackout=0.3        strip the tool definitions (models then fabricate results)
  context_truncate=0.3     cut the prompt to a budget, middle dropped (the Ollama bug)
    context_truncate.keep=2048
  naked_tool_call=0.3      rewrite a structured tool call as plain text
  garble_json=0.2          corrupt tool-call arguments into invalid JSON
  latency=0.2  latency.ms=30000    delay the reply
  http_error=0.1  http_error.code=500    return 500/429 instead of the model

Example — does your agent invent tool results when the tools disappear?
  tornado --upstream http://127.0.0.1:11434 tool_blackout=1.0
  # point your agent at http://localhost:8100/v1, run one task, watch it fabricate

Ctrl-C prints the injection report.`;

const VALUE_FLAGS = new Set(['upstream', 'port', 'seed']);
function parse(argv) {
  const o = { config: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { o.help = true; continue; }
    let m = a.match(/^--([a-z-]+)(?:=(.*))?$/);
    if (m) {
      // support both --flag=value and --flag value
      if (m[2] === undefined && VALUE_FLAGS.has(m[1]) && argv[i + 1] && !argv[i + 1].startsWith('--')) o[m[1]] = argv[++i];
      else o[m[1]] = m[2] ?? true;
      continue;
    }
    m = a.match(/^([a-z_]+)(?:\.([a-z_]+))?=(.+)$/);   // FAULT=P or FAULT.opt=V
    if (m) {
      const [, fault, opt, val] = m;
      if (!FAULTS.includes(fault)) { console.error(`unknown fault '${fault}'. Known: ${FAULTS.join(', ')}`); process.exit(2); }
      const num = Number(val);
      if (opt) { o.config[fault] = { ...(typeof o.config[fault] === 'object' ? o.config[fault] : { p: o.config[fault] ?? 1 }), [opt]: Number.isNaN(num) ? val : num }; }
      else { o.config[fault] = Number.isNaN(num) ? val : num; }
    }
  }
  return o;
}

const o = parse(process.argv.slice(2));
if (o.help) { console.log(HELP); process.exit(0); }
const upstream = o.upstream || process.env.TORNADO_UPSTREAM || 'http://127.0.0.1:11434';
if (!Object.keys(o.config).length) { console.error('turn on at least one fault, e.g. tool_blackout=0.5\n'); console.log(HELP); process.exit(2); }
const port = Number(o.port || 8100);
const seed = o.seed ? Number(o.seed) : undefined;
const server = createTornado({ upstream, config: o.config, seed });
server.listen(port, '127.0.0.1', () => {
  console.error(`tornado on http://127.0.0.1:${port}/v1  ->  ${upstream}`);
  console.error(`faults: ${JSON.stringify(o.config)}${seed !== undefined ? `  seed ${seed}` : ''}`);
  console.error('point your agent here, run it, then Ctrl-C for the report.\n');
});
const report = () => {
  const r = server.report();
  console.error(`\n── tornado report ──\ncalls: ${r.calls}   injected: ${JSON.stringify(r.injected)}`);
  process.exit(0);
};
process.on('SIGINT', report); process.on('SIGTERM', report);
