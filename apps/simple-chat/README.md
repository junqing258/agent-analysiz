# Simple Chat

An interactive Node.js 20+ CLI that demonstrates a persistent `AgentSession`, streamed output, local artifacts, and the `ModelGateway` boundary.

```bash
pnpm install
pnpm simple-chat:demo

# Development mode: incremental TypeScript compilation + Node restart on changes
pnpm simple-chat:dev -- --demo

# Real model mode
cp .env.example .env
# Set ANTHROPIC_AUTH_TOKEN and ANTHROPIC_MODEL in .env, then:
pnpm simple-chat
```

The default session log is `.agent/sessions/simple-chat.jsonl`; change it with `--session path/to/session.jsonl`. The next process run replays that log as chat history (and records interrupted tools as non-retried failures). Use `/help` in the chat for available commands and `/exit` to close it.

Real-model mode uses the Anthropic Messages API over server-side `fetch` and streams text deltas. Keep `ANTHROPIC_AUTH_TOKEN` server-side only. It sends the required `x-api-key` and `anthropic-version` headers, and maps `max_tokens` stop reasons to the SDK's length finish event. See Anthropic's [Messages stop-reason and streaming guidance](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons).

`--demo` has no network or credentials: it uses a deterministic local gateway, which makes it useful for smoke testing the app and event store.

## Model providers and `.env`

The launcher searches upward from the current directory for `.env`; a shell variable always takes precedence. Copy `.env.example` to `.env` and configure one provider:

```dotenv
MODEL_PROVIDER=anthropic
ANTHROPIC_BASE_URL=https://api.anthropic.com
ANTHROPIC_AUTH_TOKEN=your_server_side_token
ANTHROPIC_MODEL=your-model-id
```

Set `MODEL_PROVIDER=demo` for the offline gateway. The CLI also accepts `--provider anthropic`, `--model …`, and `--env path/to/.env`; those options take precedence over `.env` values. Relative `--env` paths are resolved from the directory where you started `pnpm`.

## Development mode

`pnpm simple-chat:dev -- --demo` starts the TypeScript build watcher, then starts the CLI after the first successful build. Each subsequent successful incremental build restarts the CLI. Change a file under `apps/simple-chat/src/` (or an SDK source dependency) and it recompiles and reloads. Pass normal CLI options after `--`, for example `pnpm simple-chat:dev -- --model gpt-5.6 --session .agent/dev.jsonl`.
