# 使用示例

> 脚本为零依赖 Node（`references/stock_data_fetcher.mjs`），用 `node` 直接运行。`${CLAUDE_SKILL_DIR}` 为技能目录（`.claude/skills/stock-analysis`）。

## 1. 节假日查询示例

### 查询今日是否为交易日

```bash
node "${CLAUDE_SKILL_DIR}/references/stock_data_fetcher.mjs" --holiday
```

输出:
```json
{
  "check_date": "2026-08-10",
  "is_trading_day": true,
  "weekday": 0,
  "weekday_name": "Monday",
  "last_trading_day": "2026-08-07",
  "next_trading_day": "2026-08-11",
  "calendar_source": "weekday fallback (Mon-Fri)",
  "check_time": "2026-08-10T23:12:49.508"
}
```

### 查询特定日期

```bash
node "${CLAUDE_SKILL_DIR}/references/stock_data_fetcher.mjs" --holiday --date 2025-01-06
```

> 注意：交易日判断为工作日回退（周一至周五），不识别中国法定节假日。例如元旦 2025-01-01（周三）会被判为 `is_trading_day: true`。

## 2. 股票分析示例（自动包含交易日状态）

### 分析 A 股

```bash
node "${CLAUDE_SKILL_DIR}/references/stock_data_fetcher.mjs" --stocks "600519" --days 10
```

输出包含:
```json
{
  "analysis_date": "2026-08-10",
  "trading_day_status": { "date": "2026-08-10", "is_trading_day": true, ... },
  "stocks": [ { "code": "600519", "name": "贵州茅台", ... } ]
}
```

### 分析美股

```bash
node "${CLAUDE_SKILL_DIR}/references/stock_data_fetcher.mjs" --stocks "TSLA,AAPL,MSFT" --news
```

### 分析指数

```bash
node "${CLAUDE_SKILL_DIR}/references/stock_data_fetcher.mjs" --stocks "sh000001,创业板指,沪深300"
```

### 分析基金

```bash
node "${CLAUDE_SKILL_DIR}/references/stock_data_fetcher.mjs" --stocks "fund:018358,华富数字经济混合A"
```

### 混合 + 保存信号

```bash
node "${CLAUDE_SKILL_DIR}/references/stock_data_fetcher.mjs" \
  --stocks "TSLA,600519,HK00700,上证指数,fund:018358" --news --save-signal
```

`--save-signal` 会把每只标的的信号（含评分明细与硬规则触发）追加写入 `signals.jsonl`。

## 3. 在 Claude Code 中使用

在 Claude Code 中直接输入自然语言:

```
分析下 TSLA
600519 怎么样?
看看今天的交易日状态
2025年元旦是交易日吗?
```

Claude Code 会自动:
1. 调用 Stock Analysis Skill
2. 用 `node` 运行 `stock_data_fetcher.mjs` 获取数据并判断交易日状态
3. 输出包含交易日信息的决策看板

---

更多详细信息:
- [完整使用文档](references/holiday-calendar-usage.md)
- [实现总结](IMPLEMENTATION_SUMMARY.md)
