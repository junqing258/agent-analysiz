# Decision Dashboard Output Format

## Format Specification

Use exactly this Markdown structure for the output dashboard.

### Header

```
## {DATE} 股票决策看板

{N} 只股票分析完成 | 买入: {n} | 持有: {n} | 卖出: {n}
```

### Per-Stock Card

For each stock, output one card separated by `---`.

**Category handling**: switch the card's value-row label and content per category.

| `is_index` | `is_fund` | 价格行标签 | 是否含 PE/PB | 额外段 |
|------------|-----------|------------|--------------|--------|
| false | false | `现价` | ✓ | — |
| true  | false | `现点` | ✗ | — |
| false | true  | `最新净值` | ✗ | **基金基本面** + **前 10 重仓** + **清盘预警**（若有 `warnings`） |

When `is_fund=true`, also add an **estimate badge** if `realtime.is_estimate=true`
(the value comes from the T-day intraday NAV estimate, not the official close);
the dashboard should annotate the price with `(估算)` so users know it's not the
published NAV.

```
### {NAME}({CODE}) — {SIGNAL_EMOJI} {SIGNAL_CN}

| 指标 | 数值 |
|------|------|
| 现价 | {price} ({change_pct:+.2f}%) |              ← 个股
| 现点 | {price} ({change_pct:+.2f}%) |              ← 指数
| 最新净值 | {price} ({change_pct:+.2f}% 估算) |     ← 基金（若 is_estimate=true 加"估算"标记）
| 综合评分 | {score}/100 |
| 信号 | {signal_cn} |
| ⚠️ 硬规则 | {hard_rules_triggered} |     ← 仅当 hard_rules_triggered 非空时插入此行，逐条列出（如"RSI > 80 (超买)"）；为空则省略整行
| 市盈率 | {pe_ratio} |                              ← 仅个股
| 市净率 | {pb_ratio} |                              ← 仅个股

**技术面**
- 均线: MA5={ma5} MA10={ma10} MA20={ma20} | {alignment_cn}
- MACD: DIF={dif} DEA={dea} 柱={hist} | {macd_signal_cn}
- RSI: RSI6={rsi6} RSI12={rsi12} RSI24={rsi24} | {rsi_zone_cn}
- 量能: 量比 {vol_ratio} | {vol_trend_cn}    ← 基金省略本行（开放式基金无挂单）
- 乖离率: MA5乖离 {bias_ma5:+.2f}%

**基金基本面** ← 仅 is_fund=true 时插入此段
- 类型: {fund_info.fund_type} ｜ 规模: {fund_info.size}{清盘预警标记} ｜ 成立: {fund_info.established}
- 基金经理: {fund_info.manager}（{fund_info.company}）
- 业绩基准: {fund_info.benchmark}

**前 10 重仓** ← 仅 is_fund=true 时插入此段
| 排名 | 股票 | 占净值比 |
|------|------|----------|
| 1 | {holdings[0].stock_name} ({holdings[0].stock_code}) | {holdings[0].pct}% |
| ... | ... | ... |

**AI 判断**
{2-3 sentence comprehensive analysis. The signal label is locked by the script — narrate around it, do not contradict it. If hard_rules_triggered is non-empty, explicitly note why the buy was vetoed (e.g. "评分虽高但 MA5 乖离 >5%，追高风险，降级为持有").}

**看多因素**
- {factor1}
- {factor2}

**风险因素**
- {risk1}
- {risk2}
- ⚠️ {warnings[0]}    ← 基金清盘预警如有，作为风险因素首条置顶

**价格目标** ← 基金该段标题改为"净值目标"，列名改为"入场净值/目标净值/止损净值"
| 入场价 | 目标价 | 止损价 |
|--------|--------|--------|
| {entry} | {target} (+{pct}%) | {stop_loss} (-{pct}%) |

**最新消息**
- {news1}
- {news2}
- {news3}

---
```

### Fund-specific conventions

- 清盘预警（来自 JSON 的 `warnings` 数组）必须在卡片显眼位置呈现 — 优先做法是在"基金基本面"那行的"规模"后直接打 🟥/🟨 标签（红/黄牌），并在"风险因素"段首条复述
- "估算净值"标记：当 `realtime.is_estimate=true` 时，价格行 `change_pct` 之后追加"（估算，5-23 公布官方净值）"等说明，避免用户误以为是已公布数据
- 持仓段：列出前 10，前 3 务必标注所属赛道（如 "CPO/光通信龙头"），便于用户快速理解基金风格
- 基金"价格目标"应该叫"净值目标"，但脚本字段沿用 entry/target/stop_loss

### Signal Emoji Mapping

| Signal | Emoji | Chinese |
|--------|-------|---------|
| strong_buy | 🟢 | 强烈买入 |
| buy | 🔵 | 买入 |
| hold | 🟡 | 持有 |
| wait | ⚪ | 观望 |
| sell | 🟠 | 卖出 |
| strong_sell | 🔴 | 强烈卖出 |

### Alignment Chinese Mapping

| English | Chinese |
|---------|---------|
| strong_bullish | 强势多头排列 |
| bullish | 多头排列 |
| weak_bullish | 弱多排列 |
| consolidation | 盘整 |
| weak_bearish | 弱空排列 |
| bearish | 空头排列 |
| strong_bearish | 强势空头排列 |

### MACD Signal Chinese Mapping

| English | Chinese |
|---------|---------|
| golden_cross_above_zero | 零轴上金叉 |
| golden_cross | 金叉 |
| crossing_above_zero | 上穿零轴 |
| bullish | 多头运行 |
| neutral | 中性 |
| bearish | 空头运行 |
| death_cross | 死叉 |
| crossing_below_zero | 下穿零轴 |

### Volume Trend Chinese Mapping

| English | Chinese |
|---------|---------|
| heavy_volume_up | 放量上涨 |
| heavy_volume_down | 放量下跌 |
| shrink_pullback | 缩量回调 |
| shrink_up | 缩量上涨 |
| normal | 正常 |

### RSI Zone Chinese Mapping

| English | Chinese |
|---------|---------|
| overbought | 超买 |
| strong | 强势 |
| neutral | 中性 |
| weak | 弱势 |
| oversold | 超卖 |

### Footer

```
> 免责声明: 以上分析仅供参考，不构成投资建议。投资有风险，入市需谨慎。
> 数据来源: EastMoney / Yahoo | 分析时间: {timestamp}
```
