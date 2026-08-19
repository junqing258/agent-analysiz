# Simple Chat

An interactive Node.js 20+ CLI that demonstrates a persistent `AgentSession`, streamed output, local artifacts, and the `ModelGateway` boundary.

```bash
pnpm install
pnpm simple-chat:demo

# Development mode: incremental TypeScript compilation + Node restart on changes
pnpm simple-chat:dev -- --demo

# Real model mode
cp .env.example .env
# Set OPENAI_API_KEY in .env, then:
pnpm simple-chat
```

The default session log is `.agent/sessions/simple-chat.jsonl`; change it with `--session path/to/session.jsonl`. The next process run replays that log as chat history (and records interrupted tools as non-retried failures). Use `/help` in the chat for available commands and `/exit` to close it.

Real-model mode uses the OpenAI Responses API over server-side `fetch`, streams `response.output_text.delta`, and sets `store: false`. Keep `OPENAI_API_KEY` server-side only. See the [official OpenAI Responses quickstart](https://platform.openai.com/docs/quickstart/make-your-first-api-request) and [streaming reference](https://platform.openai.com/docs/api-reference/responses-streaming/response/refusal?lang=node.js).

`--demo` has no network or credentials: it uses a deterministic local gateway, which makes it useful for smoke testing the app and event store.

## Model providers and `.env`

The launcher searches upward from the current directory for `.env`; a shell variable always takes precedence. Copy `.env.example` to `.env` and configure one provider:

```dotenv
MODEL_PROVIDER=openai
OPENAI_API_KEY=your_server_side_key
OPENAI_MODEL=gpt-5.6
# Optional for an OpenAI-compatible endpoint; `/responses` is appended.
# OPENAI_BASE_URL=https://api.openai.com/v1
```

Set `MODEL_PROVIDER=demo` for the offline gateway. The CLI also accepts `--provider openai`, `--model …`, and `--env path/to/.env`; those options take precedence over `.env` values. Relative `--env` paths are resolved from the directory where you started `pnpm`.

## Development mode

`pnpm simple-chat:dev -- --demo` starts the TypeScript build watcher, then starts the CLI after the first successful build. Each subsequent successful incremental build restarts the CLI. Change a file under `apps/simple-chat/src/` (or an SDK source dependency) and it recompiles and reloads. Pass normal CLI options after `--`, for example `pnpm simple-chat:dev -- --model gpt-5.6 --session .agent/dev.jsonl`.
