# Holiday Calendar Usage Guide

## 功能说明

`stock_data_fetcher.mjs` 支持交易日判断功能（`--holiday` 模式 + 股票分析时自动附带 `trading_day_status`）。

## 判断逻辑

脚本使用**简单工作日判断**（周一至周五）：

- 零依赖、无需安装（Node ≥18 内置 `fetch`）。
- 不再使用 chinese_calendar，因此**不识别中国法定节假日与周末调休**——例如元旦（2025-01-01，周三）会被判为 `is_trading_day: true`。
- 分析时结合行情可用性判断：若某节假日当日行情仍返回（各数据源自行处理休市），脚本仍可给出数据。

## 使用方法

### 1. 查询今日交易日状态

```bash
node "${CLAUDE_SKILL_DIR}/references/stock_data_fetcher.mjs" --holiday
```

输出示例:
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

### 2. 查询指定日期

```bash
node "${CLAUDE_SKILL_DIR}/references/stock_data_fetcher.mjs" --holiday --date 2025-01-01
```

### 3. 股票分析时自动包含交易日状态

```bash
node "${CLAUDE_SKILL_DIR}/references/stock_data_fetcher.mjs" --stocks "600519" --days 10
```

输出中会包含 `trading_day_status` 字段（含 `date` / `is_trading_day` / `weekday` / `weekday_name` / `last_trading_day` / `next_trading_day`）。

## 行为说明（weekday 回退）

| 日期 | 星期 | is_trading_day（weekday 判断） | 说明 |
|------|------|-----------|------|
| 2025-01-01 | 周三 | ✅（工作日） | 元旦，实际休市但脚本判为交易日 |
| 2025-01-06 | 周一 | ✅ | 正常交易日 |
| 2025-05-01 | 周四 | ✅（工作日） | 劳动节，实际休市但脚本判为交易日 |
| 2025-10-04 | 周六 | ❌ | 周末，非交易日 |

如需精确的法定节假日/调休判断，可在外层另行接入节假日日历后叠加判断；本脚本保持零依赖、不做该增强。

## 注意事项

1. **工作日判断**: 仅周一至周五判为交易日，不识别法定节假日与调休。
2. **时区**: 所有日期使用本地时区。
3. **缓存**: 判断为纯函数，无外部状态。
