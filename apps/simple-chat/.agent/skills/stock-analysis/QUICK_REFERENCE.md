# 节假日功能快速参考卡片

## 命令速查

| 命令 | 说明 | 示例 |
|------|------|------|
| `--holiday` | 查询今日交易日状态 | `node "${CLAUDE_SKILL_DIR}/references/stock_data_fetcher.mjs" --holiday` |
| `--holiday --date YYYY-MM-DD` | 查询指定日期 | `node "${CLAUDE_SKILL_DIR}/references/stock_data_fetcher.mjs" --holiday --date 2025-01-01` |
| `--stocks "CODE"` | 股票分析(含交易日状态) | `node "${CLAUDE_SKILL_DIR}/references/stock_data_fetcher.mjs" --stocks "600519"` |

## 判断逻辑

脚本使用**工作日判断**（周一至周五），零依赖、无需安装。不再使用 chinese_calendar，因此法定节假日落在工作日时会被判为交易日——分析时结合行情可用性判断即可。

## 输出字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `is_trading_day` | bool | 是否为交易日（工作日判断） |
| `weekday` | int | 星期(0=Mon, 6=Sun) |
| `weekday_name` | str | 星期名称 |
| `last_trading_day` | str | 最近交易日(ISO格式) |
| `next_trading_day` | str | 下一交易日(ISO格式) |
| `calendar_source` | str | 数据源状态 |

## 常见用法

### 判断是否执行策略（节假日模式）

```bash
node "${CLAUDE_SKILL_DIR}/references/stock_data_fetcher.mjs" --holiday
```

### 股票分析时自动附带交易日状态

```bash
node "${CLAUDE_SKILL_DIR}/references/stock_data_fetcher.mjs" --stocks "600519"
```

> 交易日判断函数（isTradingDay / getLastTradingDay / getNextTradingDay）内置于脚本，仅通过 `--holiday` 命令行暴露。

---

完整文档: [references/holiday-calendar-usage.md](references/holiday-calendar-usage.md)
