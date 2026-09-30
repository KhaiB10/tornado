# tornado 🌪

**Chaos engineering for AI agents.** Point your agent at Tornado instead of the model API, run it as normal, and Tornado injects the real failures that break agents in production — then reports what it broke. You find the weakness in your own system, on purpose, before it finds you.

```bash
tornado --upstream http://127.0.0.1:11434 tool_blackout=1.0
# point your agent at http://localhost:8100/v1, run a task, watch what happens
```

## Why

Agents are tested on the happy path and shipped. Then the model provider truncates a long prompt and the tools silently vanish; a local model writes its tool call as text and the call never fires; the API returns a 429 mid-task. These aren't hypotheticals — they're measured failure modes ([tool-call-truncation-bench](https://github.com/KhaiB10/tool-call-truncation-bench)). Tornado injects them deliberately so you can see whether your agent degrades gracefully or **invents a result and reports it as done.**

This is the same idea as Chaos Monkey for servers: break it yourself, in a system you control, to make it survive.

## The faults

Each takes a probability `0..1`, applied per call:

| fault | the disaster it injects |
|---|---|
| `tool_blackout=0.3` | strips the tool definitions from the request — the model can't call a tool, so does it say so or fabricate? |
| `context_truncate=0.3` | cuts the prompt to a token budget, dropping the middle (exactly what Ollama does past its context) — `context_truncate.keep=2048` |
| `naked_tool_call=0.3` | rewrites a structured tool call in the reply as plain text — does your parser recover it or lose the action? |
| `garble_json=0.2` | corrupts tool-call arguments into invalid JSON |
| `latency=0.2` | delays the reply — `latency.ms=30000` — does the agent time out or double-send? |
| `http_error=0.1` | returns 500/429 instead of the model — `http_error.code=429` |

Combine them and set a `--seed N` to reproduce a run exactly.

## Measured

Against `qwen3:8b` on Ollama, one task that needs a `bash` tool:

```
DIRECT (control):            -> TOOL CALL: bash          # works
THROUGH TORNADO tool_blackout=1:  -> NO TOOL CALL. content: "```bash\nsha256sum /etc/hostname ...```"
```

With the tools gone, the model stops calling and starts *describing* — the action never happens. An agent that assumed the call fired now proceeds on a result that doesn't exist. (Under a system prompt that pushes for a final answer, models go further and fabricate the hash outright — 8/8 in the benchmark above.) Tornado is how you find that in a test instead of in production.

## Use it

```bash
npm install -g @khaib10/tornado

# 1. run tornado in front of your model API
tornado --upstream https://api.openai.com --port 8100 tool_blackout=0.5 naked_tool_call=0.3 http_error=0.1

# 2. point your agent's base URL at http://localhost:8100/v1 and run your normal tasks or test suite
# 3. Ctrl-C for the report of what was injected
```

Everything that isn't `POST /v1/chat/completions` passes straight through, so it's a drop-in.

## Scope and honesty

- Tornado is for **systems you own or are authorized to test** — your agent, your staging, a client's with consent. It creates controlled failures to harden your own stack; it is not for attacking anyone else's.
- Response-mutation faults (`naked_tool_call`, `garble_json`) apply to non-streaming responses; request-side faults, `latency` and `http_error` apply to streaming too.
- It speaks the OpenAI chat-completions shape (Ollama, vLLM, OpenAI, DeepSeek, …).

Part of a planned suite of AI-agent resilience tools (🦈 Shark — leak/anomaly detection, 🐍 Viper — injection strikes, 🌀 Hurricane — sustained soak). Built on the same research as [ollama-guard](https://github.com/KhaiB10/ollama-guard), [honeyprompt](https://github.com/KhaiB10/honeyprompt) and [agent-blackbox](https://github.com/KhaiB10/agent-blackbox).

## Test

```bash
npm test
```

## License

MIT
