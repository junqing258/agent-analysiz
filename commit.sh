#!/usr/bin/env bash

set -euo pipefail

# CLI 工具优先级：环境变量 > 按顺序检测可用工具
if [[ "${COMMIT_CLI:-}" ]]; then
  CLI_TOOL="$COMMIT_CLI"
elif command -v claude >/dev/null 2>&1; then
  CLI_TOOL="claude"
elif command -v codex >/dev/null 2>&1; then
  CLI_TOOL="codex"
else
  echo "未检测到 claude 或 codex CLI，请确认已安装并加入 PATH。" >&2
  exit 1
fi

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

CLI_TOOL_LABEL="$(printf '%s' "$CLI_TOOL" | awk '{print toupper(substr($0, 1, 1)) substr($0, 2)}')"

EXCLUDE_PATTERNS=(
  ':(exclude)pnpm-lock.yaml'
  ':(exclude)package-lock.json'
  ':(exclude).DS_Store'
  ':(exclude)**/.DS_Store'
)

# git add .

# 检测已暂存的改动
echo -e "${BLUE}检测已暂存的改动...${NC}"

if git diff --cached --quiet -- . "${EXCLUDE_PATTERNS[@]}"; then
  echo -e "${RED}没有检测到已暂存的改动，请先执行 git add .${NC}"
  exit 1
fi
echo -e "${BLUE}已检测到暂存改动${NC}"

tmp_output="$(mktemp)"
cleanup() {
  rm -f "$tmp_output"
}
trap cleanup EXIT

# 根据工具类型构建执行命令
echo -e "${BLUE}选用 CLI 工具：${CLI_TOOL_LABEL}${NC}"
if [[ "$CLI_TOOL" == "claude" ]]; then
  if [[ "${COMMIT_MODEL:-}" ]]; then
    echo -e "${BLUE}使用模型：${COMMIT_MODEL}${NC}"
  else
    echo -e "${BLUE}使用模型：claude 默认模型（未设置 COMMIT_MODEL）${NC}"
  fi
  if [[ "${COMMIT_BASE_URL:-}" ]]; then
    export ANTHROPIC_BASE_URL="$COMMIT_BASE_URL"
  fi
  exec_cmd=(
    claude
    --print
    --output-format text
    # 不落盘会话、不可被 /resume 拾起，避免新增会话
    --no-session-persistence
    # 禁用全部工具：模型无法用 Write 写记忆文件，避免污染记忆（生成提交信息无需任何工具）
    --tools ""
  )
  if [[ "${COMMIT_MODEL:-}" ]]; then
    exec_cmd+=(--model "$COMMIT_MODEL")
  fi
else
  exec_cmd=(
    codex exec
    --ephemeral
  )
  if [[ "${COMMIT_MODEL:-}" ]]; then
    exec_cmd+=(--model "$COMMIT_MODEL")
  fi
  if [[ "${CODEX_COMMIT_IGNORE_USER_CONFIG:-}" == "1" ]]; then
    exec_cmd+=(--ignore-user-config)
  fi
  exec_cmd+=(--output-last-message "$tmp_output" -)
fi

echo -e "${BLUE}通过 ${CLI_TOOL_LABEL} 生成提交信息...${NC}"

(
  printf '为下面的阶段性差异编写 Conventional Commits git 提交消息，用简体中文输出。只输出提交消息本身，不要代码围栏、注释或多余前后缀。\n\n'
  printf '格式约定：\n'
  printf '1. 首行为标题，必须是合法的 Conventional Commits：用反引号整体包裹，形如 `type(scope): 简述`。type 不可省略，仅从 feat、fix、docs、chore、test、refactor、style、perf、build、ci、revert 中选取；scope 与现有提交历史一致。禁止把文件名或模块名直接当作 type。\n'
  printf '2. 标题与正文之间空一行。当差异需要解释时，用 `说明：` 起一段，逐条以 `-` 列出关键改动；改动中出现的字段名、配置项等用反引号包裹。\n'
  printf '3. 仅当差异确实需要说明时才写正文，单一且一目了然的改动可只输出标题。\n'
  printf '4. 标题简明概括意图，正文聚焦"改了什么、为什么"，不复述 diff 细节。\n\n'
  printf 'Diff:\n```diff\n'
  git diff --cached -- . "${EXCLUDE_PATTERNS[@]}"
  printf '```\n'
) | "${exec_cmd[@]}" 2>&1 | if [[ "$CLI_TOOL" == "claude" ]]; then
  cat > "$tmp_output"
else
  cat >/dev/null
fi || {
  echo -e "${RED}${CLI_TOOL_LABEL} 生成提交信息失败：${NC}" >&2
  cat "$tmp_output" >&2
  exit 1
}

echo -e "${GREEN}提交信息生成完成${NC}"

commit_message="$(node - "$tmp_output" <<'NODE'
const content = require('fs').readFileSync(process.argv[2], 'utf8').trim();
process.stdout.write(content);
NODE
)"

if [[ -z "$commit_message" ]]; then
  echo -e "${RED}${CLI_TOOL_LABEL} 未返回提交信息。${NC}" >&2
  exit 1
fi

echo "生成的提交信息："
echo -e "${BLUE}  $commit_message${NC}"

# echo -e "${BLUE}执行 git commit...${NC}"
# git commit -m "$commit_message"
# echo -e "${GREEN}提交完成${NC}"

read -r -p "是否使用该提交信息? [Y/n] " reply
reply="${reply:-Y}"
if [[ "$reply" =~ ^[Yy]$ ]]; then
  git commit -m "$commit_message"
else
  # read -r -p "请输入自定义提交信息: " manual_message
  # git commit -m "$manual_message"
  echo -e "${YELLOW}输入自定义提交信息，重新提交"
fi
