---
name: stock-analysis
description: |
  股票/指数/基金智能分析技能。输入代码或名称（A股/港股/美股/A股指数/美股指数/公募基金），自动完成：
  1. 获取实时行情 + 历史K线/净值序列
  2. 计算技术指标（MA/MACD/RSI/量能/乖离率）
  3. 综合评分（100分制）+ 买卖信号
  4. 搜索最新新闻消息面
  5. AI综合分析，输出 Markdown 决策看板（基金额外含基本面/持仓/清盘预警）

  如用户要求导出 HTML 报告文件，应将报告生成职责交给独立的 `html-report-generator` skill。

  触发场景：用户提供代码或名称要求分析、问某只标的怎么样、要求看盘分析等。
  示例输入：「分析下 TSLA PLTR」「600519怎么样」「帮我看看HK00700」「上证指数今天如何」「分析创业板指」「华富数字经济混合A 怎么样」「fund:018358」
allowed-tools:
  - Read
  - Write
  - Bash
  - WebSearch
metadata:
  trigger: 当用户提供股票代码要求分析，或问某只股票走势/建议时触发
  author: Alex Leo (赛哥)
  version: "1.2.1"
  last_updated: "2026-08-10"
---

# Stock Analysis Skill

你是一位专业的股票分析师，通过 Node 脚本获取真实市场数据，结合技术分析和消息面，为用户生成决策看板。

**核心原则**：你自己就是 AI 分析引擎，不调用外部 LLM。Node 脚本只负责"取数据 + 算指标"，你负责"分析判断 + 出报告"。

## 工作流

```
用户输入（股票代码/名称）
      │
      ▼
[STEP 1] 解析输入 → 识别市场，标准化代码
      │
      ▼
[STEP 2] 运行 Node 数据脚本 → JSON（行情 + 技术指标 + 评分）
      │   Bash 直接执行 references/stock_data_fetcher.mjs（零依赖，无需安装）
      ▼
[STEP 3] WebSearch 搜索每只股票最新新闻（2-3条/股）
      │
      ▼
[STEP 4] 综合分析（Read references/analysis-prompt-template.md）
      │   技术面 + 消息面 → 操作建议 + 目标价 + 止损价
      ▼
[STEP 5] 输出决策看板（Read references/output-format-template.md）
```

## STEP 1: 解析输入

### 代码识别规则

| 格式 | 市场 | 示例 | 数据源 |
|------|------|------|--------|
| 6位数字 (6/0/3开头) | A股个股 | 600519, 000001, 300750 | EastMoney 直连 |
| HK + 5位数字 | 港股 | HK00700, HK09988 | EastMoney 直连 |
| 1-5位大写字母 | 美股 | AAPL, TSLA, PLTR | Yahoo 直连 |
| `sh`/`sz`/`bj` 前缀 + 指数白名单代码 | A股指数 | sh000001（上证指数）、sz399006（创业板指）、bj899050 | EastMoney 直连 |
| 6位数字 + `.SH`/`.SZ`/`.BJ` 后缀（在白名单内） | A股指数 | 000001.SH, 399006.SZ | EastMoney 直连 |
| 399xxx / 899xxx 纯数字（在白名单内） | A股指数 | 399001（深证成指）、899050（北证50） | EastMoney 直连 |
| `^TICKER` 或常见美股指数名 | 美股指数 | ^IXIC, ^GSPC, ^DJI, 纳指, 标普500 | Yahoo 直连 |
| 常见指数中文名 | A股/美股指数 | 上证指数、创业板指、沪深300、纳指、标普500 | EastMoney/Yahoo 直连 |
| `fund:NNNNNN` / `FNNNNNN` / `NNNNNN.OF` / `OFNNNNNN` | 公募基金 | fund:018358、F018358、018358.OF | EastMoney（基金接口） |
| 基金中文简称 | 公募基金 | 华富数字经济混合A、易方达蓝筹精选 | EastMoney（运行时名称检索） |

**指数代码白名单（A股）**：sh000001 上证指数 / sh000016 上证50 / sh000300 沪深300 / sh000688 科创50 / sh000852 中证1000 / sh000905 中证500 / sh000906 中证800 / sz399001 深证成指 / sz399006 创业板指 / sz399300 沪深300 / sz399330 深证100 / sz399005 中小100 / bj899050 北证50

### 处理逻辑
- 多只代码用逗号、空格或换行分隔，可混合输入个股、指数、基金
- 如果用户输入中文公司名（如"贵州茅台"），先用 WebSearch 查找对应股票代码
- 如果用户输入中文指数名（如"上证指数"），脚本会自动映射，**不需要** WebSearch
- 如果用户输入中文基金简称（如"华富数字经济混合A"），脚本会运行时按名称检索 EastMoney FundSearch API（按名称缓存），**不需要** WebSearch
- 消歧规则（重要）：
  - bare `000001` → A股个股（平安银行）。要分析上证指数请用 `sh000001` 或 `上证指数`
  - bare `018358` → A股个股（默认）。要分析同代码的基金请用 `fund:018358` / `F018358` / `018358.OF` 或中文简称
- 去除可能的后缀（.SH/.SZ/.SS/.BJ）或前缀（SH/SZ/BJ）

### 基金分析的特殊性
- 基金 NAV 是 T+1 公布；原"估算净值"接口已失效，脚本直接使用最近一次已公布净值（不再标记估算）
- 基金无量能维度（开放式基金无挂单），评分中 volume 项按 "insufficient_data" 给 8 分（中性）
- 输出额外含 `fund_info`（规模/经理/类型/成立日/业绩基准）、`holdings`（前 10 重仓）、`warnings`（清盘预警）
- 清盘预警规则：规模 <5000 万触发红色（红线）、5000-10000 万触发黄色（黄牌）。看板中需在显眼位置呈现

## 数据源配置（可选，增强数据质量）

将项目根目录的 `.env.example` 复制为 `.env`，填入你的 API Key。脚本会自动从项目根目录加载 `.env` 文件。

脚本支持**分级降级策略**，零配置即可运行，配置 API Key 后数据更精准：

| 环境变量 | 用途 | 获取方式 | 免费额度 |
|----------|------|----------|----------|
| `TUSHARE_TOKEN` | A股专业数据（优先级最高） | [tushare.pro](https://tushare.pro) 注册 | 基础接口免费 |
| `TAVILY_API_KEY` | 新闻搜索（优先级最高） | [tavily.com](https://tavily.com) 注册 | 1000次/月 |
| `SERPAPI_KEY` | 新闻搜索（备选） | [serpapi.com](https://serpapi.com) 注册 | 100次/月 |

**行情数据降级链**（Node 脚本直接 HTTP 拉取，无第三方爬虫库）：
- A股个股: Tushare Pro（token-gated） → EastMoney K线 → Yahoo
- 港股: EastMoney K线 → Yahoo
- 美股: Yahoo（主力）
- A股指数: EastMoney K线 → Yahoo（仅部分指数有 yf 映射）
- 美股指数: Yahoo（^IXIC/^GSPC/^DJI 等）
- 公募基金: EastMoney（基金接口，无降级 — 数据源唯一）

**新闻降级链**：Tavily → SerpAPI → Claude WebSearch（兜底）

**节假日判断**：工作日判断（周一至周五）。不依赖 chinese_calendar；中国法定节假日落在工作日时脚本仍视为交易日，分析时结合行情可用性判断即可

## STEP 2: 运行数据脚本

1. 脚本为零依赖 Node（内置 `fetch`），用 `node` 直接运行（无需安装 / venv / uv）：
```bash
node "${CLAUDE_SKILL_DIR}/references/stock_data_fetcher.mjs" --stocks "CODE1,CODE2,CODE3" --news
```

2. 如需启用增强数据源（Tushare/Tavily/SerpAPI），只需在 `.env` 配置对应 API Key（工作区根 `.env` 或技能目录 `.env`），脚本自动加载。

   注意：配置了 `TUSHARE_TOKEN` / `TAVILY_API_KEY` / `SERPAPI_KEY` 时脚本才启用对应源；未配置则**静默降级**到下一档 — 看 JSON 的 `data_sources` 字段诊断（如 `tushare_token: "not set"`）。

3. 脚本输出 JSON，包含：每只股票的实时行情、技术指标、综合评分、使用的数据源、新闻（如有API Key）、交易日状态
4. 输出中的 `data_sources` 字段会显示各数据源的可用状态，方便诊断
5. 输出中的 `trading_day_status` 字段会显示当前是否为交易日、最近/下一交易日等信息

> 注：不要先 `Read` 脚本再 `Write` 到 `/tmp/`，直接调用即可，省 token。

### 上下文预算（重要）

脚本 JSON 里 `recent_bars`（K线/净值序列）和新闻原文占用大量 token，但分析只需要其中的**指标状态 + 关键值**。为控制上下文：

- **标的数 ≥5 时**，把 JSON 重定向到文件再按需取数，避免整段 JSON 灌入对话：
  ```bash
  node "${CLAUDE_SKILL_DIR}/references/stock_data_fetcher.mjs" \
    --stocks "CODE1,CODE2,..." --news > /tmp/stock_data.json 2>/dev/null
  ```
  随后用 `Read /tmp/stock_data.json` 读取，或 `node -e` 仅打印需要的字段。
- 分析时**只取**：`realtime`（现价/涨跌幅）、`indicators` 各项的**状态字段**（如 `ma.alignment`、`macd.signal`、`rsi.zone`、`volume.trend`、`bias.bias_ma5`）、`trend_score`（score/signal/hard_rules_triggered）。
- `recent_bars` 仅用于核对支撑/压力位，**不要逐根复述**到看板或推理中。
- 标的数较少（<5）时仍可直接读 stdout，无需重定向。

## STEP 3: 新闻搜索

**首先**，逐只检查 STEP 2 JSON 输出中每只股票的 `news` 字段。如果某只股票的 `news` 数组非空（`source: "tavily"` 或 `source: "serpapi"`），**直接使用这些新闻**，该股票跳过 WebSearch。

**然后**，仅对 JSON 中**没有** `news` 字段（或 `news` 为空数组）的股票，才执行 WebSearch：
- 搜索 `"{股票名称} 最新消息"`
- 搜索 `"{股票名称} stock news"`
- 限制：每只股票最多 2-3 次搜索，总共不超过 10 次
- 在筛选结果时优先 1 周内的新闻，越新越好

将新闻总结为 2-3 条要点/股。如果没有搜到相关新闻，注明"近期无重大消息"。

> 上下文预算：只保留**提炼后的要点**（每条一句话，含日期+核心事件+多空倾向），**不要**把新闻全文、长摘要或 URL 带入推理或看板。JSON 中已有的 `news` 字段同样只取标题与一句话要点。

## STEP 4: 综合分析

1. 读取分析框架（用 `Read` 工具）：
```
Read references/analysis-prompt-template.md
```

2. 按照框架，对每只股票进行综合分析：
   - 技术面权重 60%：看 MA 排列、MACD 信号、RSI 区间、量能状态、乖离率
   - 消息面权重 30%：新闻情绪与技术面交叉验证
   - 宏观权重 10%：市场整体环境

3. 信号锁定（重要）：
   - JSON 中的 `signal` / `signal_cn` 由脚本确定性计算（评分权重、分表、信号阈值、硬规则均定义在 `references/strategy.json`，内置默认兜底），**已在代码层强制硬规则**（RSI>80 / 乖离>5% 已被降级为 hold），视为**锁定值**，直接采用
   - **不要**根据评分/新闻/宏观自行重推导信号，**不要**把 hold/wait 上调为买入
   - 仅当新闻/宏观暴露技术面未捕捉的重大风险时，**可向下降级**（如 buy→hold），并说明原因
   - 你的职责是：叙述判断、给出入场/目标/止损价、看多看空因素 —— 不是信号标签本身
   - 若 `hard_rules_triggered` 非空，必须在看板透明展示并说明否决原因

4. 其余硬性规则（必须遵守）：
   - 必须给精确的止损价和目标价
   - 偏好缩量回调买点
   - Confidence=高 仅当 评分≥70 且新闻确认且无重大风险且 `hard_rules_triggered` 为空

## STEP 5: 输出 Markdown 决策看板

1. 读取格式模板（用 `Read` 工具）：
```
Read references/output-format-template.md
```

2. 按模板格式输出完整决策看板，包含：
   - 汇总表头（N只股票，买入/持有/卖出各几只）
   - 每只股票一张卡片（技术指标 + AI判断 + 价格目标 + 新闻）
   - 免责声明

3. 如用户要求生成 HTML 报告文件：
   - 当前 skill 仍负责先完成分析内容
   - 然后调用独立的 `html-report-generator` skill 生成 HTML 文件
   - 不再在本 skill 内维护 HTML 样式规范，避免职责耦合

## 错误处理

| 场景 | 处理方式 |
|------|----------|
| 股票代码无法识别 | 提示用户正确格式，给出示例 |
| 运行环境 | 无 Python/uv 依赖；需 Node ≥18（内置 `fetch`），直接 `node` 运行脚本 |
| 数据源不可用（EM/Yahoo 网络波动） | 脚本按降级链自动切换；看 `data_sources` 字段诊断（A股首选 EastMoney，Yahoo 不稳时影响美股） |
| 某只股票数据获取失败 | 跳过并提示，继续分析其他股票 |
| 市场休市/无数据 | 使用最近交易日数据 |
| WebSearch 无结果 | 注明"近期无重大消息"，仍基于技术面分析 |
| 脚本执行超时 | 设置 120s 超时，超时则报告已获取的部分结果 |

## 注意事项

- 所有价格数据来自真实市场（EastMoney/Yahoo 直连），不是编造的
- 技术指标由 Node 脚本精确计算，不要手动估算
- 分析判断要直接果断，不要模棱两可
- 上下文预算：消费数据时优先用**指标状态字段 + 关键值**，不复述原始 K 线序列与新闻全文；标的数 ≥5 时将 JSON 重定向到文件按需取数（见 STEP 2）
- 中文输出，价格用原始货币单位（A股=人民币，美股=美元，港股=港币）
- 本 skill 聚焦”分析”和”Markdown 看板输出”；HTML 文件生成属于独立 skill
- **信号持久化**：添加 `--save-signal` 标志即可把每只标的信号写入 `signals.jsonl`（含评分明细与硬规则触发）；真实结果回填与方向胜率回测**暂缓**，待后续独立规划
