# Simple Chat

一个面向 Node.js 20+ 的交互式命令行示例，用于演示持久化 `AgentSession`、流式输出、本地产物存储与 `ModelGateway` 抽象边界。

```bash
pnpm install
pnpm simple-chat:demo

# 开发模式：增量编译 TypeScript，并在代码变更后重启 Node 进程
pnpm simple-chat:dev -- --demo

# 真实模型模式
cp .env.example .env
# 在 .env 中设置 ANTHROPIC_AUTH_TOKEN 与 ANTHROPIC_MODEL 后执行：
pnpm simple-chat
```

默认会话日志位于 `.agent/sessions/simple-chat.jsonl`，可通过 `--session path/to/session.jsonl` 修改。下次启动会自动重放日志作为对话历史；若发现未完成的工具调用，则会记录为不会自动重试的失败结果。

启动后会进入基于 Ink + React 的全屏 TUI：消息区会持续显示历史消息，状态栏显示当前流式生成状态，底部输入框持续接收新消息。按 Enter 发送；可使用左右方向键、Backspace 编辑，`Ctrl-U` 清空输入；输入 `/help` 查看命令，`/clear` 仅清空屏幕显示，`/exit`（或 `Ctrl-C` / `Ctrl-D`）退出。退出后再次以同一 `--session` 启动，仍会续接同一段对话。TUI 需要在交互式终端中运行。

Agent 可以读取启动命令所在工作区内的文件，并可使用 `read`、`glob`、`grep`、`write` 与 `edit` 工具。路径不能越过该工作区；创建新文件可直接使用 `write`，覆盖已有文件或 `edit` 则必须在本会话中先读取目标文件。读取自动许可，`write` 和 `edit` 会在 TUI 中显示确认提示，按 `y` 仅允许本次操作，按 `n` 拒绝。

真实模型模式通过服务端 `fetch` 调用 Anthropic Messages API 或 OpenAI Responses API，并流式输出文本与工具调用增量。`ANTHROPIC_AUTH_TOKEN` 和 `OPENAI_API_KEY` 只能保存在服务端；Anthropic 适配器会发送 `x-api-key` 与 `anthropic-version` 请求头，并把 `max_tokens` 停止原因映射为 SDK 的长度结束事件。参考 Anthropic 的 [停止原因与流式响应说明](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons)。

`--demo` 不访问网络，也不需要凭据。它使用确定性的本地网关，适合对应用和事件存储进行冒烟测试。

## 模型供应商与 `.env`

启动器会从当前目录向上查找 `.env`；Shell 环境变量始终优先于 `.env`。复制 `.env.example` 为 `.env` 后，配置一个模型供应商：

```dotenv
MODEL_PROVIDER=anthropic
ANTHROPIC_BASE_URL=https://api.anthropic.com
ANTHROPIC_AUTH_TOKEN=your_server_side_token
ANTHROPIC_MODEL=your-model-id
```

设置 `MODEL_PROVIDER=demo` 可使用离线网关。CLI 还支持 `--provider anthropic`、`--model …` 与 `--env path/to/.env`，这些命令行选项优先于 `.env` 中的值。相对 `--env` 路径以执行 `pnpm` 时所在目录为基准解析。

## 开发模式

`pnpm simple-chat:dev -- --demo` 会先启动 TypeScript 编译监听器，首次构建成功后启动 CLI。之后每次增量编译成功，CLI 都会自动重启。修改 `apps/simple-chat/src/` 下的文件（或 SDK 源码依赖）后，应用会重新编译并加载。可在 `--` 后传入常规 CLI 参数，例如：`pnpm simple-chat:dev -- --model your-model-id --session .agent/dev.jsonl`。

## 诊断日志

无法收到回复时，使用 `--debug` 或设置 `SIMPLE_CHAT_DEBUG=1`：

```bash
pnpm simple-chat:dev -- --debug --provider anthropic
```

日志会依次显示配置加载、请求发起、HTTP 状态、SSE 事件类型及流结束原因。为避免泄露敏感信息，它不会输出 `ANTHROPIC_AUTH_TOKEN`、请求/响应正文或模型文本。
