#!/usr/bin/env node
/**
 * Stock Data Fetcher + Technical Indicator Calculator + Holiday Calendar
 * (Node.js port — zero npm dependencies, Node >= 18 for global fetch)
 *
 * Outputs structured JSON for Claude Code analysis. No AI/LLM calls — pure data + math.
 *
 * Replaces the original Python stock_data_fetcher.py which depended on the
 * akshare / efinance / yfinance / tushare / chinese_calendar ecosystem + uv.
 * Data sources are now direct HTTP calls (built-in fetch):
 *
 *   A-share:  Tushare Pro (if TUSHARE_TOKEN set) > EastMoney kline > Yahoo
 *   HK:       EastMoney kline > Yahoo
 *   US:       Yahoo (chart API; primary for US)
 *   CN index: EastMoney kline > Yahoo (if yf mapping exists)
 *   US index: Yahoo
 *   Fund:     EastMoney (NAV history + basic info + holdings)
 *
 * Holiday calendar: weekday check (Mon-Fri). No chinese_calendar dependency.
 *
 * News search priority (via --news):
 *   Tavily (if TAVILY_API_KEY set) > SerpAPI (if SERPAPI_KEY set) > skip (agent uses WebSearch)
 *
 * Usage:
 *   node stock_data_fetcher.mjs --stocks "600519,TSLA,HK00700,sh000001,创业板指" [--days 120] [--news]
 *   node stock_data_fetcher.mjs --holiday [--date 2025-01-01]
 *
 * Environment variables (optional, from workspace-root/.env or skill-dir/.env):
 *   TUSHARE_TOKEN / TAVILY_API_KEY / SERPAPI_KEY
 */
import { readFileSync, mkdirSync, appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(__dirname, "..");
const WORKSPACE_ROOT = path.resolve(SKILL_DIR, "../../.."); // <workspace>/.claude/skills/<skill>/../../..

// ============================================================
// .env loading (workspace-root first, then skill-dir; never overrides existing env)
// ============================================================

function parseEnvFile(file) {
  try {
    const out = {};
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (m) {
        let v = m[2].trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
          v = v.slice(1, -1);
        }
        out[m[1]] = v;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function loadEnv() {
  for (const [k, v] of Object.entries(parseEnvFile(path.join(WORKSPACE_ROOT, ".env")))) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
  for (const [k, v] of Object.entries(parseEnvFile(path.join(SKILL_DIR, ".env")))) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

loadEnv();

// ============================================================
// Utilities
// ============================================================

const _log = (msg) => process.stderr.write(`[INFO] ${msg}\n`);

const pad = (n, w = 2) => String(n).padStart(w, "0");
const nowLocalIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, "0")}`;
};
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const nowTimeStr = () => {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const fmtDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const toDate = (str) => {
  const [y, m, day] = str.split("-").map(Number);
  return new Date(y, m - 1, day);
};
const addDays = (d, n) => {
  const nd = new Date(d);
  nd.setDate(nd.getDate() + n);
  return nd;
};

function safeFloat(val) {
  if (val === null || val === undefined || val === "-" || val === "") return null;
  const f = Number(val);
  if (!Number.isFinite(f)) return null;
  return Math.round(f * 10000) / 10000;
}

const round4 = (n) => (n === null || n === undefined ? null : Math.round(n * 10000) / 10000);
const round2 = (n) => (n === null || n === undefined ? null : Math.round(n * 100) / 100);

/** Lenient numeric parse for table cells: strips commas / % / whitespace. */
function parseNum(val) {
  if (val === null || val === undefined || val === "-" || val === "") return null;
  const cleaned = String(val).replace(/[,%\s]/g, "");
  if (!cleaned || cleaned === "-") return null;
  const f = Number(cleaned);
  return Number.isFinite(f) ? round4(f) : null;
}

async function httpText(url, { headers = {}, timeoutMs = 15000 } = {}) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0", ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function httpJson(url, { headers = {}, timeoutMs = 15000 } = {}) {
  const text = await httpText(url, { headers, timeoutMs });
  return JSON.parse(text);
}

/** Generic timeout guard so one slow stock never blocks the pool forever. */
function withTimeout(promise, ms = 120000, label = "task") {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} exceeded ${ms}ms`)), ms)),
  ]);
}

// ============================================================
// Holiday Calendar (weekday fallback — no chinese_calendar dependency)
// ============================================================

const WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function isTradingDay(checkDate) {
  return (checkDate.getDay() + 6) % 7 < 5; // Mon-Fri
}

function getLastTradingDay(checkDate, maxLookback = 7) {
  for (let i = 0; i < maxLookback; i++) {
    const candidate = addDays(checkDate, -i);
    if (isTradingDay(candidate)) return candidate;
  }
  _log(`Could not find trading day within ${maxLookback} days, using ${fmtDate(checkDate)}`);
  return checkDate;
}

function getNextTradingDay(checkDate, maxLookahead = 7) {
  for (let i = 1; i <= maxLookahead; i++) {
    const candidate = addDays(checkDate, i);
    if (isTradingDay(candidate)) return candidate;
  }
  _log(`Could not find next trading day within ${maxLookahead} days, using ${fmtDate(addDays(checkDate, 1))}`);
  return addDays(checkDate, 1);
}

function getTradingDayStatus(checkDate) {
  const weekday = (checkDate.getDay() + 6) % 7;
  return {
    date: fmtDate(checkDate),
    is_trading_day: isTradingDay(checkDate),
    weekday,
    weekday_name: WEEKDAY_NAMES[weekday],
    last_trading_day: fmtDate(getLastTradingDay(addDays(checkDate, -1))),
    next_trading_day: fmtDate(getNextTradingDay(addDays(checkDate, 1))),
  };
}

// ============================================================
// Registries + code classification
// ============================================================

const INDEX_REGISTRY = {
  sh000001: { name: "上证指数", yf: "000001.SS" },
  sh000016: { name: "上证50", yf: "000016.SS" },
  sh000300: { name: "沪深300", yf: "000300.SS" },
  sh000688: { name: "科创50", yf: "" },
  sh000852: { name: "中证1000", yf: "" },
  sh000905: { name: "中证500", yf: "000905.SS" },
  sh000906: { name: "中证800", yf: "" },
  sz399001: { name: "深证成指", yf: "399001.SZ" },
  sz399005: { name: "中小100", yf: "" },
  sz399006: { name: "创业板指", yf: "399006.SZ" },
  sz399300: { name: "沪深300", yf: "" },
  sz399330: { name: "深证100", yf: "" },
  bj899050: { name: "北证50", yf: "" },
};

const US_INDEX_REGISTRY = {
  "^IXIC": "纳斯达克综合指数",
  "^GSPC": "标普500",
  "^DJI": "道琼斯指数",
  "^RUT": "罗素2000",
  "^VIX": "VIX恐慌指数",
  "^SSEC": "上证指数",
};

const INDEX_NAME_TO_KEY = {
  上证指数: "sh000001", 上证综指: "sh000001", 上证综合指数: "sh000001", 上证: "sh000001",
  深证成指: "sz399001", 深成指: "sz399001", 深证: "sz399001",
  创业板指: "sz399006", 创业板: "sz399006",
  沪深300: "sh000300", 沪深300指数: "sh000300", hs300: "sh000300",
  上证50: "sh000016",
  科创50: "sh000688", 科创板50: "sh000688",
  中证500: "sh000905", 中证500指数: "sh000905",
  中证1000: "sh000852",
  中证800: "sh000906",
  深证100: "sz399330",
  北证50: "bj899050",
  纳指: "^IXIC", 纳斯达克: "^IXIC", 纳斯达克综合指数: "^IXIC",
  标普500: "^GSPC", 标普: "^GSPC",
  道指: "^DJI", 道琼斯: "^DJI", 道琼斯指数: "^DJI",
};

const _FUND_NAME_CACHE = new Map();

/** Resolve a Chinese fund short name to (code, displayName) via EastMoney search API. */
async function resolveFundName(name) {
  if (!name) return null;
  if (!/[一-鿿]/.test(name)) return null; // no CJK chars → not a fund name
  if (_FUND_NAME_CACHE.has(name)) return _FUND_NAME_CACHE.get(name);
  let result = null;
  try {
    const url = `https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx?m=1&key=${encodeURIComponent(name)}`;
    const data = await httpJson(url, { headers: { Referer: "https://fund.eastmoney.com/" } });
    const rows = (data.Datas || []).filter((r) => r.CODE && r.NAME);
    const exact = rows.find((r) => r.NAME === name || r.SHORTNAME === name);
    const pick = exact || rows.find((r) => r.NAME?.startsWith(name) || r.SHORTNAME?.startsWith(name));
    if (pick) result = [String(pick.CODE), pick.NAME || pick.SHORTNAME || name];
  } catch (e) {
    _log(`fund name resolve failed for '${name}': ${e.message || e}`);
  }
  _FUND_NAME_CACHE.set(name, result);
  return result;
}

async function classifyStock(raw) {
  const code = String(raw).trim();
  const upper = code.toUpperCase();

  // 0. 中文/俗称索引名
  if (Object.prototype.hasOwnProperty.call(INDEX_NAME_TO_KEY, code)) {
    const key = INDEX_NAME_TO_KEY[code];
    if (key.startsWith("^")) return ["us_index", key, US_INDEX_REGISTRY[key] || key];
    return ["cn_index", key, INDEX_REGISTRY[key].name];
  }

  // 0.5 显式基金代码
  if (upper.startsWith("FUND:")) {
    const tail = upper.slice(5);
    if (/^\d{6}$/.test(tail)) return ["cn_fund", tail, tail];
  }
  if (upper.endsWith(".OF")) {
    const base = upper.slice(0, -3);
    if (/^\d{6}$/.test(base)) return ["cn_fund", base, base];
  }
  if (upper.startsWith("OF") && upper.length === 8 && /^\d{6}$/.test(upper.slice(2))) {
    return ["cn_fund", upper.slice(2), upper.slice(2)];
  }
  if (upper.startsWith("F") && upper.length === 7 && /^\d{6}$/.test(upper.slice(1))) {
    return ["cn_fund", upper.slice(1), upper.slice(1)];
  }

  // 1. 美股指数 ^IXIC / ^GSPC
  if (upper.startsWith("^") && upper.length >= 2 && upper.length <= 8) {
    return ["us_index", upper, US_INDEX_REGISTRY[upper] || upper];
  }

  // 2. 港股 HK00700
  if (upper.startsWith("HK") && /^\d+$/.test(upper.slice(2))) {
    return ["cn_hk", upper.slice(2), upper];
  }

  // 3. 带 sh/sz/bj 前缀
  if (upper.length >= 8 && ["SH", "SZ", "BJ"].includes(upper.slice(0, 2))) {
    const rest = upper.slice(2);
    if (/^\d{6}$/.test(rest)) {
      const key = upper.toLowerCase();
      if (INDEX_REGISTRY[key]) return ["cn_index", key, INDEX_REGISTRY[key].name];
      return ["cn_a", rest, rest];
    }
  }

  // 4. 带后缀 000001.SH
  if (upper.includes(".")) {
    const [base, suffix] = upper.split(".");
    if (/^\d{6}$/.test(base) && ["SH", "SS", "SZ", "BJ"].includes(suffix)) {
      const prefix = { SH: "sh", SS: "sh", SZ: "sz", BJ: "bj" }[suffix];
      const key = `${prefix}${base}`;
      if (INDEX_REGISTRY[key]) return ["cn_index", key, INDEX_REGISTRY[key].name];
      return ["cn_a", base, base];
    }
  }

  // 5. 纯数字 6 位
  if (/^\d{6}$/.test(upper)) {
    if (upper.startsWith("399")) {
      const key = `sz${upper}`;
      if (INDEX_REGISTRY[key]) return ["cn_index", key, INDEX_REGISTRY[key].name];
    }
    if (upper.startsWith("899")) {
      const key = `bj${upper}`;
      if (INDEX_REGISTRY[key]) return ["cn_index", key, INDEX_REGISTRY[key].name];
    }
    return ["cn_a", upper, upper];
  }

  // 6. 美股个股
  if (/^[A-Z]{1,5}$/.test(upper)) return ["us", upper, upper];

  // 7. 中文基金简称
  const fund = await resolveFundName(code);
  if (fund) return ["cn_fund", fund[0], fund[1] || code];

  return ["unknown", code, code];
}

function toYfinanceCode(code, market) {
  if (market === "us_index") return code;
  if (market === "cn_index") return (INDEX_REGISTRY[code] || {}).yf || "";
  if (market === "cn_hk") return `${String(Number(code)).padStart(4, "0")}.HK`;
  if (market === "us") return code;
  if (/^(600|601|603|605|688)/.test(code)) return `${code}.SS`;
  if (/^(51|52|56|58)/.test(code)) return `${code}.SS`;
  return `${code}.SZ`;
}

function parseStockCodes(raw) {
  return String(raw || "")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ============================================================
// Data fetchers (direct HTTP, graceful degradation)
// ============================================================

function ohlcvBar(row) {
  return {
    date: String(row.date ?? ""),
    open: safeFloat(row.open),
    high: safeFloat(row.high),
    low: safeFloat(row.low),
    close: safeFloat(row.close),
    volume: safeFloat(row.volume),
    amount: safeFloat(row.amount),
    pct_chg: safeFloat(row.pct_chg),
  };
}

function emSecidForACode(code) {
  return /^(6|9)/.test(code) ? `1.${code}` : `0.${code}`;
}

function emSecidForIndexKey(key) {
  const bare = key.slice(2);
  return `${key.startsWith("sh") ? 1 : 0}.${bare}`;
}

/** EastMoney kline: f51=date f52=open f53=close f54=high f55=low f56=vol f57=amount f58=amplitude f59=pct_chg f60=change f61=turnover */
async function fetchEmKline(secid, days) {
  const base = "https://push2his.eastmoney.com/api/qt/stock/kline/get";
  const qs = `secid=${secid}&klt=101&fqt=1&beg=0&end=20500101&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61`;
  const data = await httpJson(`${base}?${qs}`, { headers: { Referer: "https://quote.eastmoney.com/" } });
  const d = data.data;
  if (!d || !Array.isArray(d.klines) || d.klines.length === 0) {
    throw new Error(`EastMoney returned no data for secid ${secid}`);
  }
  const ohlcv = d.klines.slice(-days).map((line) => {
    const p = line.split(",");
    return ohlcvBar({
      date: p[0],
      open: p[1],
      close: p[2],
      high: p[3],
      low: p[4],
      volume: p[5],
      amount: p[6],
      pct_chg: p[8],
    });
  });
  return { ohlcv, name: String(d.name || "") };
}

/** Tushare Pro daily (token-gated, priority 0 for A-share). */
async function fetchTushareA(code, days) {
  const token = process.env.TUSHARE_TOKEN;
  if (!token) throw new Error("TUSHARE_TOKEN not set");
  const tsCode = /^(600|601|603|688)/.test(code) ? `${code}.SH` : `${code}.SZ`;
  const endDate = todayStr().replace(/-/g, "");
  const start = new Date();
  start.setDate(start.getDate() - days * 2);
  const startDate = `${start.getFullYear()}${pad(start.getMonth() + 1)}${pad(start.getDate())}`;
  const body = {
    api_name: "daily",
    token,
    params: { ts_code: tsCode, start_date: startDate, end_date: endDate },
    fields: "trade_date,open,close,high,low,vol,amount,pct_chg",
  };
  const res = await fetch("https://api.tushare.pro", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json();
  const items = data?.data?.items;
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error(`Tushare returned no data for ${code}: ${data?.msg || ""}`);
  }
  const fields = data.data.fields;
  const ohlcv = items
    .map((row) => {
      const r = {};
      fields.forEach((f, i) => (r[f] = row[i]));
      const d = String(r.trade_date);
      return ohlcvBar({
        date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`,
        open: r.open,
        close: r.close,
        high: r.high,
        low: r.low,
        volume: r.vol,
        amount: r.amount,
        pct_chg: r.pct_chg,
      });
    })
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-days);
  _log(`[${code}] Using Tushare Pro (premium)`);
  return { ohlcv, name: "" };
}

/** Yahoo chart API — OHLCV + realtime meta. Tries query1 then query2. */
async function fetchYahoo(ticker, days) {
  const range = `${Math.max(days, 30)}d`;
  let lastErr = null;
  for (const host of ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]) {
    try {
      const url = `https://${host}/v8/finance/chart/${encodeURIComponent(ticker)}?range=${range}&interval=1d`;
      const data = await httpJson(url, { timeoutMs: 15000 });
      const result = data?.chart?.result?.[0];
      if (!result) throw new Error(`Yahoo returned no result for ${ticker}`);
      const ts = result.timestamp || [];
      const q = result.indicators?.quote?.[0] || {};
      const bars = [];
      for (let i = 0; i < ts.length; i++) {
        const t = new Date(ts[i] * 1000);
        const close = safeFloat(q.close?.[i]);
        bars.push({
          date: fmtDate(new Date(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate())),
          open: safeFloat(q.open?.[i]),
          high: safeFloat(q.high?.[i]),
          low: safeFloat(q.low?.[i]),
          close,
          volume: safeFloat(q.volume?.[i]),
          amount: null,
          pct_chg: null,
        });
      }
      for (let i = 1; i < bars.length; i++) {
        const prev = bars[i - 1].close;
        if (prev && prev > 0) bars[i].pct_chg = round2(((bars[i].close - prev) / prev) * 100);
      }
      return { ohlcv: bars.slice(-days), meta: result.meta || {}, name: String(result.meta?.longName || result.meta?.shortName || "") };
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`Yahoo failed for ${ticker}: ${lastErr?.message || lastErr}`);
}

/** Fund NAV history via EastMoney lsjz API (T+1 published NAV). EM caps LSJZList at 20 rows/page — paginate until we have `days` bars. */
async function fetchFundNav(code, days) {
  const all = [];
  const maxPages = Math.max(7, Math.ceil(days / 20) + 1);
  for (let pageIndex = 1; pageIndex <= maxPages; pageIndex++) {
    const url = `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}&pageIndex=${pageIndex}&pageSize=20`;
    const data = await httpJson(url, { headers: { Referer: "https://fundf10.eastmoney.com/" } });
    const list = data?.Data?.LSJZList;
    if (!Array.isArray(list) || list.length === 0) break;
    all.push(...list);
    if (all.length >= days) break;
  }
  if (all.length === 0) {
    throw new Error(`EastMoney returned no NAV data for fund ${code}`);
  }
  const ohlcv = all
    .map((r) => {
      const nav = safeFloat(r.DWJZ);
      return ohlcvBar({
        date: String(r.FSRQ || ""),
        open: nav,
        close: nav,
        high: nav,
        low: nav,
        pct_chg: safeFloat(r.JZZZL),
      });
    })
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-days);
  return { ohlcv, name: "" };
}

const stripTags = (html) => String(html || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

/** Fund basic info via EastMoney jbgk page (<th>/<td> table pairs). */
async function fetchFundBasic(code) {
  try {
    const html = await httpText(`https://fundf10.eastmoney.com/jbgk_${code}.html`, {
      headers: { Referer: "https://fundf10.eastmoney.com/" },
    });
    const map = {};
    const re = /<th[^>]*>([\s\S]*?)<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/g;
    let m;
    while ((m = re.exec(html))) {
      const key = stripTags(m[1]);
      if (key) map[key] = stripTags(m[2]);
    }
    const findValue = (needle) => {
      const k = Object.keys(map).find((key) => key.includes(needle));
      return k ? map[k] : "";
    };
    const name = findValue("基金简称") || (html.match(/<title>([^<()]*)/)?.[1] || "").trim() || code;
    // 基金类型 嵌在「基金代码」td 里，形如 "018358（前端） 基金类型 混合型-偏股"
    let fundType = "";
    const ft = (findValue("基金代码") || "").match(/基金类型\s*([^\s（(]+)/);
    if (ft) fundType = ft[1];
    // 规模优先取「净资产规模」（清盘风险相关），回退「成立日期/规模」的份额数
    const normSize = (str) => {
      const m = (str || "").match(/([\d.]+)\s*(亿元|亿|万元|万)/);
      if (!m) return "";
      return m[2].startsWith("亿") ? `${m[1]}亿` : `${m[1]}万`;
    };
    const size = normSize(findValue("净资产规模")) || normSize(findValue("成立日期/规模"));
    let established = "";
    const dateMatch = (findValue("成立日期/规模") || "").match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
    if (dateMatch) established = `${dateMatch[1]}-${pad(dateMatch[2])}-${pad(dateMatch[3])}`;
    return {
      name,
      fund_type: fundType,
      manager: findValue("基金经理人") || findValue("基金经理"),
      company: findValue("基金管理人"),
      established,
      size,
      benchmark: findValue("业绩比较基准"),
    };
  } catch (e) {
    _log(`[fund:${code}] basic info failed: ${e.message || e}`);
    return {};
  }
}

/** Fund top-N holdings via EastMoney FundArchivesDatas (var apidata JS). */
async function fetchFundHoldings(code, topN = 10) {
  const currentYear = new Date().getFullYear();
  for (const year of [currentYear, currentYear - 1]) {
    try {
      const url = `https://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&code=${code}&topline=${topN}&year=${year}`;
      const text = await httpText(url, { headers: { Referer: "https://fundf10.eastmoney.com/" } });
      // content 字符串后跟 ",arryear:[...]" —— 用贪婪匹配取最后一个 `"` 作为闭合引号，兼容内容内部出现的双引号
      const contentMatch = text.match(/content\s*:\s*"([\s\S]*)"\s*,\s*[a-zA-Z_]+:/);
      if (!contentMatch) continue;
      const content = contentMatch[1];
      // Parse the embedded HTML table: header row maps column names → indices.
      const tableMatch = content.match(/<table[\s\S]*?>([\s\S]*?)<\/table>/i);
      if (!tableMatch) continue;
      const table = tableMatch[1];
      const rows = [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) => r[1]);
      // 列头可能含 <br/>（"占净值<br />比例"）→ 去空白后再匹配
      const headerCells = rows[0] ? [...rows[0].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map((c) => stripTags(c[1]).replace(/\s+/g, "")) : [];
      const col = {};
      headerCells.forEach((h, i) => {
        if (h.includes("序号")) col.rank = i;
        else if (h.includes("股票代码")) col.stock_code = i;
        else if (h.includes("股票名称")) col.stock_name = i;
        else if (h.includes("占净值")) col.pct = i;
        else if (h.includes("持仓市值")) col.value = i;
      });
      // 季度不在表格列里，在 h4 标题中，如 "2026年2季度股票投资明细"
      const quarter = content.match(/(\d{4}年\d季度)股票投资明细/)?.[1] || "";
      const holdings = [];
      for (const rowHtml of rows.slice(1)) {
        const cells = [...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => c[1]);
        if (cells.length < 2) continue;
        holdings.push({
          rank: col.rank !== undefined ? parseNum(stripTags(cells[col.rank])) : null,
          stock_code: col.stock_code !== undefined ? stripTags(cells[col.stock_code]) : "",
          stock_name: col.stock_name !== undefined ? stripTags(cells[col.stock_name]) : "",
          pct: col.pct !== undefined ? parseNum(stripTags(cells[col.pct])) : null,
          value_wan: col.value !== undefined ? parseNum(stripTags(cells[col.value])) : null,
          quarter,
        });
      }
      if (holdings.length) return holdings.slice(0, topN);
    } catch (e) {
      _log(`[fund:${code}] holdings ${year} failed: ${e.message || e}`);
    }
  }
  return [];
}

async function fetchCnFund(code, days) {
  const { ohlcv, name: navName } = await fetchFundNav(code, days);
  const basic = await fetchFundBasic(code);
  const holdings = await fetchFundHoldings(code);
  const name = basic.name || navName || code;
  let realtime = {};
  if (!realtime.price && ohlcv.length) {
    const last = ohlcv[ohlcv.length - 1];
    realtime = { name, price: last.close, change_pct: last.pct_chg };
  }
  return { ohlcv, realtime, name, source: "em", fund_info: basic, holdings };
}

// --- Realtime fetchers ---

/** EastMoney single-stock quote (UTF-8 JSON, price-like fields are integers x100). */
async function fetchEmQuote(secid, fallbackName) {
  const fields = "f43,f44,f45,f46,f47,f48,f50,f57,f58,f60,f116,f117,f162,f167,f168,f169,f170,f171";
  const data = await httpJson(
    `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=${fields}`,
    { headers: { Referer: "https://quote.eastmoney.com/" } },
  );
  const d = data.data;
  if (!d) throw new Error(`EastMoney quote empty for secid ${secid}`);
  const f = (k) => (d[k] === undefined || d[k] === null || d[k] === "-" ? null : Number(d[k]));
  const price = f("f43") === null ? null : f("f43") / 100;
  return {
    name: String(d.f58 || fallbackName),
    price,
    change_pct: f("f170") === null ? null : f("f170") / 100,
    change_amount: f("f169") === null ? null : f("f169") / 100,
    volume: f("f47"),
    amount: f("f48"),
    amplitude: f("f171") === null ? null : f("f171") / 100,
    turnover_rate: f("f168") === null ? null : f("f168") / 100,
    pe_ratio: f("f162") === null ? null : f("f162") / 100,
    pb_ratio: f("f167") === null ? null : f("f167") / 100,
    total_mv: f("f116"),
    circ_mv: f("f117"),
    high: f("f44") === null ? null : f("f44") / 100,
    low: f("f45") === null ? null : f("f45") / 100,
    open: f("f46") === null ? null : f("f46") / 100,
    pre_close: f("f60") === null ? null : f("f60") / 100,
    volume_ratio: f("f50") === null ? null : f("f50") / 100,
  };
}

function realtimeFromYahooMeta(meta, fallbackName) {
  const rt = {
    name: meta.longName || meta.shortName || fallbackName,
    price: safeFloat(meta.regularMarketPrice),
    pre_close: safeFloat(meta.chartPreviousClose),
    high: safeFloat(meta.regularMarketDayHigh),
    low: safeFloat(meta.regularMarketDayLow),
    volume: safeFloat(meta.regularMarketVolume),
    week_52_high: safeFloat(meta.fiftyTwoWeekHigh),
    week_52_low: safeFloat(meta.fiftyTwoWeekLow),
  };
  if (!rt.change_pct && rt.price !== null && rt.pre_close && rt.pre_close > 0) {
    rt.change_pct = round2(((rt.price - rt.pre_close) / rt.pre_close) * 100);
  }
  return rt;
}

function fillRealtimeFromOhlcv(realtime, ohlcv, name, logCode) {
  realtime = realtime || {};
  if (!realtime.price && ohlcv && ohlcv.length) {
    const last = ohlcv[ohlcv.length - 1];
    if (realtime.name === undefined) realtime.name = name;
    realtime.price = last.close;
    if (!realtime.change_pct) realtime.change_pct = last.pct_chg;
    _log(`[${logCode}] Realtime fallback to last OHLCV bar`);
  }
  return realtime;
}

// --- Top-level per-market fetchers (priority chains) ---

async function fetchCnA(code, days) {
  let ohlcv = null;
  let source = "unknown";
  let fetchedName = "";
  const errors = [];

  if (process.env.TUSHARE_TOKEN) {
    try {
      const r = await fetchTushareA(code, days);
      ohlcv = r.ohlcv;
      source = "tushare";
      fetchedName = r.name || fetchedName;
    } catch (e) {
      errors.push(`tushare: ${e.message || e}`);
    }
  }
  if (ohlcv === null) {
    try {
      const r = await fetchEmKline(emSecidForACode(code), days);
      ohlcv = r.ohlcv;
      source = "em";
      fetchedName = r.name || fetchedName;
    } catch (e) {
      errors.push(`em: ${e.message || e}`);
    }
  }
  if (ohlcv === null) {
    try {
      const yf = toYfinanceCode(code, "cn_a");
      if (yf) {
        const r = await fetchYahoo(yf, days);
        ohlcv = r.ohlcv;
        source = "yahoo";
        fetchedName = r.name || fetchedName;
      }
    } catch (e) {
      errors.push(`yahoo: ${e.message || e}`);
    }
  }
  if (ohlcv === null) throw new Error(`All data sources failed for A-share ${code}: ${errors.join("; ")}`);

  const displayName = fetchedName || code;
  let realtime = {};
  try {
    realtime = await fetchEmQuote(emSecidForACode(code), displayName);
  } catch (e) {
    _log(`[${code}] realtime quote failed: ${e.message || e}`);
  }
  realtime = fillRealtimeFromOhlcv(realtime, ohlcv, displayName, code);
  return { ohlcv, realtime, name: realtime.name || displayName, source };
}

async function fetchHk(code, days) {
  let ohlcv = null;
  let source = "unknown";
  let fetchedName = "";
  const errors = [];
  try {
    const r = await fetchEmKline(`116.${code}`, days);
    ohlcv = r.ohlcv;
    source = "em";
    fetchedName = r.name || fetchedName;
  } catch (e) {
    errors.push(`em: ${e.message || e}`);
  }
  if (ohlcv === null) {
    try {
      const yf = toYfinanceCode(code, "cn_hk");
      if (yf) {
        const r = await fetchYahoo(yf, days);
        ohlcv = r.ohlcv;
        source = "yahoo";
        fetchedName = r.name || fetchedName;
      }
    } catch (e) {
      errors.push(`yahoo: ${e.message || e}`);
    }
  }
  if (ohlcv === null) throw new Error(`All data sources failed for HK${code}: ${errors.join("; ")}`);

  const displayName = fetchedName || `HK${code}`;
  let realtime = {};
  try {
    realtime = await fetchEmQuote(`116.${code}`, displayName);
  } catch (e) {
    _log(`[HK${code}] realtime quote failed: ${e.message || e}`);
  }
  realtime = fillRealtimeFromOhlcv(realtime, ohlcv, displayName, `HK${code}`);
  return { ohlcv, realtime, name: realtime.name || displayName, source };
}

async function fetchUs(code, days) {
  const r = await fetchYahoo(code, days);
  let realtime = {};
  try {
    realtime = realtimeFromYahooMeta(r.meta, code);
  } catch {
    realtime = {};
  }
  realtime = fillRealtimeFromOhlcv(realtime, r.ohlcv, code, code);
  return { ohlcv: r.ohlcv, realtime, name: realtime.name || r.name || code, source: "yahoo" };
}

async function fetchCnIndex(key, days) {
  let ohlcv = null;
  let source = "unknown";
  const errors = [];
  try {
    const r = await fetchEmKline(emSecidForIndexKey(key), days);
    ohlcv = r.ohlcv;
    source = "em";
  } catch (e) {
    errors.push(`em: ${e.message || e}`);
  }
  if (ohlcv === null) {
    const yfTicker = (INDEX_REGISTRY[key] || {}).yf || "";
    if (yfTicker) {
      try {
        const r = await fetchYahoo(yfTicker, days);
        ohlcv = r.ohlcv;
        source = "yahoo";
      } catch (e) {
        errors.push(`yahoo: ${e.message || e}`);
      }
    }
  }
  if (ohlcv === null) throw new Error(`All data sources failed for index ${key}: ${errors.join("; ")}`);

  const name = (INDEX_REGISTRY[key] || {}).name || key;
  let realtime = {};
  try {
    realtime = await fetchEmQuote(emSecidForIndexKey(key), name);
  } catch (e) {
    _log(`[${key}] index realtime failed: ${e.message || e}`);
  }
  realtime = fillRealtimeFromOhlcv(realtime, ohlcv, name, key);
  if (realtime.name === undefined) realtime.name = name;
  return { ohlcv, realtime, name, source };
}

async function fetchUsIndex(ticker, days) {
  const r = await fetchYahoo(ticker, days);
  const name = US_INDEX_REGISTRY[ticker] || ticker;
  let realtime = { name };
  try {
    realtime = realtimeFromYahooMeta(r.meta, name);
  } catch {
    realtime = { name };
  }
  realtime = fillRealtimeFromOhlcv(realtime, r.ohlcv, name, ticker);
  return { ohlcv: r.ohlcv, realtime, name, source: "yahoo" };
}

// --- News (optional) ---

async function searchNews(stockName, code, maxResults = 5) {
  const tavilyKey = process.env.TAVILY_API_KEY;
  if (tavilyKey) {
    try {
      const res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: tavilyKey,
          query: `${stockName} ${code} stock news`,
          max_results: maxResults,
          search_depth: "basic",
        }),
        signal: AbortSignal.timeout(15000),
      });
      const data = await res.json();
      const results = (data.results || []).slice(0, maxResults).map((r) => ({
        title: r.title || "",
        content: (r.content || "").slice(0, 200),
        url: r.url || "",
        source: "tavily",
      }));
      if (results.length) {
        _log(`[${code}] News via Tavily (${results.length} results)`);
        return results;
      }
    } catch (e) {
      _log(`[${code}] Tavily failed: ${e.message || e}`);
    }
  }

  const serpapiKey = process.env.SERPAPI_KEY;
  if (serpapiKey) {
    try {
      const url = `https://serpapi.com/search.json?q=${encodeURIComponent(`${stockName} stock news`)}&api_key=${encodeURIComponent(serpapiKey)}&num=${maxResults}`;
      const data = await httpJson(url);
      const results = (data.organic_results || []).slice(0, maxResults).map((r) => ({
        title: r.title || "",
        content: (r.snippet || "").slice(0, 200),
        url: r.link || "",
        source: "serpapi",
      }));
      if (results.length) {
        _log(`[${code}] News via SerpAPI (${results.length} results)`);
        return results;
      }
    } catch (e) {
      _log(`[${code}] SerpAPI failed: ${e.message || e}`);
    }
  }

  _log(`[${code}] No news API configured, skipping (Claude will use WebSearch)`);
  return [];
}

// ============================================================
// Technical Indicators
// ============================================================

function calcEma(data, period) {
  if (!data || data.length < period) return data.map(() => null);
  const result = new Array(period - 1).fill(null);
  const multiplier = 2 / (period + 1);
  let sma = 0;
  for (let i = 0; i < period; i++) sma += data[i];
  result.push(sma / period);
  for (let i = period; i < data.length; i++) {
    result.push((data[i] - result[result.length - 1]) * multiplier + result[result.length - 1]);
  }
  return result;
}

function calcMa(closes, periods) {
  const result = {};
  for (const p of periods) {
    const key = `MA${p}`;
    if (closes.length >= p) {
      let sum = 0;
      for (let i = closes.length - p; i < closes.length; i++) sum += closes[i];
      result[key] = round4(sum / p);
    } else {
      result[key] = null;
    }
  }

  const ma5 = result.MA5;
  const ma10 = result.MA10;
  const ma20 = result.MA20;

  if (ma5 !== null && ma10 !== null && ma20 !== null) {
    if (ma5 > ma10 && ma10 > ma20) {
      result.alignment = "bullish";
      const spread = ma20 > 0 ? ((ma5 - ma20) / ma20) * 100 : 0;
      result.alignment_detail = spread > 5 ? "strong_bullish" : "bullish";
    } else if (ma5 < ma10 && ma10 < ma20) {
      result.alignment = "bearish";
      const spread = ma20 > 0 ? ((ma20 - ma5) / ma20) * 100 : 0;
      result.alignment_detail = spread > 5 ? "strong_bearish" : "bearish";
    } else if (ma5 > ma10 && ma10 <= ma20) {
      result.alignment = "weak_bullish";
      result.alignment_detail = "weak_bullish";
    } else if (ma5 < ma10 && ma10 >= ma20) {
      result.alignment = "weak_bearish";
      result.alignment_detail = "weak_bearish";
    } else {
      result.alignment = "consolidation";
      result.alignment_detail = "consolidation";
    }
  } else {
    result.alignment = "insufficient_data";
    result.alignment_detail = "insufficient_data";
  }
  return result;
}

function calcMacd(closes, fast = 12, slow = 26, signal = 9) {
  if (closes.length < slow + signal) {
    return { DIF: null, DEA: null, hist: null, signal: "insufficient_data" };
  }
  const emaFast = calcEma(closes, fast);
  const emaSlow = calcEma(closes, slow);
  const difList = [];
  for (let i = 0; i < closes.length; i++) {
    if (emaFast[i] !== null && emaSlow[i] !== null) difList.push(emaFast[i] - emaSlow[i]);
    else difList.push(null);
  }
  const validDif = difList.filter((v) => v !== null);
  if (validDif.length < signal) {
    return { DIF: null, DEA: null, hist: null, signal: "insufficient_data" };
  }
  const deaList = calcEma(validDif, signal);
  const currDif = validDif[validDif.length - 1];
  const currDea = deaList[deaList.length - 1];
  const prevDif = validDif.length >= 2 ? validDif[validDif.length - 2] : null;
  const prevDea = deaList.length >= 2 ? deaList[deaList.length - 2] : null;

  const hist = currDif !== null && currDea !== null ? round4((currDif - currDea) * 2) : null;

  let macdSignal = "neutral";
  if (currDif !== null && currDea !== null && prevDif !== null && prevDea !== null) {
    const currDiff = currDif - currDea;
    const prevDiff = prevDif - prevDea;
    if (prevDiff <= 0 && currDiff > 0) macdSignal = currDif > 0 ? "golden_cross_above_zero" : "golden_cross";
    else if (prevDiff >= 0 && currDiff < 0) macdSignal = "death_cross";
    else if (currDif > 0 && currDea > 0) macdSignal = "bullish";
    else if (currDif < 0 && currDea < 0) macdSignal = "bearish";
    if (prevDif < 0 && currDif >= 0) macdSignal = "crossing_above_zero";
    else if (prevDif > 0 && currDif <= 0) macdSignal = "crossing_below_zero";
  }

  return {
    DIF: currDif !== null ? round4(currDif) : null,
    DEA: currDea !== null ? round4(currDea) : null,
    hist,
    signal: macdSignal,
  };
}

function calcRsi(closes, periods) {
  const result = {};
  for (const period of periods) {
    const key = `RSI${period}`;
    if (closes.length < period + 1) {
      result[key] = null;
      continue;
    }
    const deltas = [];
    for (let i = 1; i < closes.length; i++) deltas.push(closes[i] - closes[i - 1]);
    const gains = deltas.map((d) => Math.max(0, d));
    const losses = deltas.map((d) => Math.max(0, -d));
    let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
    let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < deltas.length; i++) {
      avgGain = (avgGain * (period - 1) + gains[i]) / period;
      avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    }
    const rsi = avgLoss === 0 ? 100.0 : 100 - 100 / (1 + avgGain / avgLoss);
    result[key] = round2(rsi);
  }

  const rsi12 = result.RSI12;
  if (rsi12 !== null) {
    if (rsi12 >= 80) result.zone = "overbought";
    else if (rsi12 >= 60) result.zone = "strong";
    else if (rsi12 >= 40) result.zone = "neutral";
    else if (rsi12 >= 20) result.zone = "weak";
    else result.zone = "oversold";
  } else {
    result.zone = "unknown";
  }
  return result;
}

function calcVolumeAnalysis(volumes, closes) {
  if (volumes.length < 6 || closes.length < 2) {
    return { vol_ratio: null, trend: "insufficient_data" };
  }
  let avgVol5 = 0;
  for (let i = volumes.length - 6; i < volumes.length - 1; i++) avgVol5 += volumes[i];
  avgVol5 /= 5;
  const currVol = volumes[volumes.length - 1];
  const volRatio = avgVol5 > 0 ? round2(currVol / avgVol5) : null;
  const priceUp = closes[closes.length - 1] >= closes[closes.length - 2];

  let trend;
  if (volRatio === null) trend = "unknown";
  else if (volRatio >= 1.5 && priceUp) trend = "heavy_volume_up";
  else if (volRatio >= 1.5 && !priceUp) trend = "heavy_volume_down";
  else if (volRatio <= 0.7 && !priceUp) trend = "shrink_pullback";
  else if (volRatio <= 0.7 && priceUp) trend = "shrink_up";
  else trend = "normal";

  return { vol_ratio: volRatio, trend };
}

function calcBias(closes, maData) {
  if (!closes.length) return {};
  const curr = closes[closes.length - 1];
  const result = {};
  for (const key of ["MA5", "MA10", "MA20"]) {
    const maVal = maData[key];
    if (maVal && maVal > 0) result[`bias_${key.toLowerCase()}`] = round2(((curr - maVal) / maVal) * 100);
  }
  return result;
}

function calcSupport(closes, maData) {
  if (!closes.length) return { support_ma5: false, support_ma10: false };
  const curr = closes[closes.length - 1];
  const ma5 = maData.MA5;
  const ma10 = maData.MA10;
  let supportMa5 = false;
  let supportMa10 = false;
  if (ma5 && curr > 0) supportMa5 = (Math.abs(curr - ma5) / curr) * 100 <= 1.0;
  if (ma10 && curr > 0) supportMa10 = (Math.abs(curr - ma10) / curr) * 100 <= 1.5;
  return { support_ma5: supportMa5, support_ma10: supportMa10 };
}

// ============================================================
// Composite Trend Scoring (100 points) — strategy from strategy.json
// ============================================================

// Embedded fallback — must mirror references/strategy.json.
const DEFAULT_STRATEGY = {
  name: "default-embedded",
  weights: { trend: 30, bias: 20, volume: 15, macd: 15, rsi: 10, support: 10 },
  trend_scores: {
    strong_bullish: 30, bullish: 26, weak_bullish: 18,
    consolidation: 12, weak_bearish: 8, bearish: 4,
    strong_bearish: 0, insufficient_data: 12,
  },
  trend_default: 12,
  bias_null_score: 10,
  bias_default_score: 10,
  bias_bands: [
    { min: -3, max: 0, score: 20 },
    { min: 0, max: 2, score: 18 },
    { min: 2, max: 5, score: 14 },
    { min: 5, max: null, score: 4 },
    { min: -5, max: -3, score: 14 },
    { min: null, max: -5, score: 6 },
  ],
  volume_scores: {
    shrink_pullback: 15, heavy_volume_up: 12, normal: 10,
    shrink_up: 6, heavy_volume_down: 0, insufficient_data: 8, unknown: 8,
  },
  volume_default: 8,
  macd_scores: {
    golden_cross_above_zero: 15, crossing_above_zero: 13, golden_cross: 12,
    bullish: 10, neutral: 7, bearish: 3, death_cross: 0,
    crossing_below_zero: 1, insufficient_data: 7,
  },
  macd_default: 7,
  rsi_scores: {
    oversold: 10, strong: 8, neutral: 5, weak: 3, overbought: 0, unknown: 5,
  },
  rsi_default: 5,
  support_ma5_points: 5,
  support_ma10_points: 5,
  signal_rules: [
    { signal: "strong_buy", min_score: 75, require_alignment: ["bullish", "strong_bullish"] },
    { signal: "buy", min_score: 60, require_alignment: ["bullish", "strong_bullish", "weak_bullish"] },
    { signal: "hold", min_score: 45 },
    { signal: "wait", min_score: 30 },
    { signal: "strong_sell", require_alignment: ["bearish", "strong_bearish"] },
    { signal: "sell" },
  ],
  signal_cn: {
    strong_buy: "强烈买入", buy: "买入", hold: "持有",
    wait: "观望", sell: "卖出", strong_sell: "强烈卖出",
  },
  hard_rules: {
    applies_to_signals: ["strong_buy", "buy"],
    downgrade_to: "hold",
    rules: [
      { id: "rsi_overbought", type: "rsi_zone_equals", value: "overbought", message: "RSI > 80 (overbought)" },
      { id: "bias_overextended", type: "bias_ma5_above", threshold: 5, message_template: "MA5 乖离 {value:+.2f}% > 5% (overextended)" },
    ],
  },
};

let strategyCache = null;

function loadStrategy() {
  if (strategyCache !== null) return strategyCache;
  try {
    const loaded = JSON.parse(readFileSync(path.join(__dirname, "strategy.json"), "utf8"));
    if (typeof loaded !== "object" || loaded === null) throw new Error("strategy.json did not parse into a mapping");
    strategyCache = { ...DEFAULT_STRATEGY, ...loaded };
    process.stderr.write(`[strategy] loaded ${path.join(__dirname, "strategy.json")} (name=${strategyCache.name})\n`);
  } catch (e) {
    strategyCache = DEFAULT_STRATEGY;
    process.stderr.write(`[strategy] failed to load strategy.json (${e.message || e}) -- using embedded default\n`);
  }
  return strategyCache;
}

function scoreBias(biasMa5, strategy) {
  if (biasMa5 === null || biasMa5 === undefined) return strategy.bias_null_score ?? 10;
  for (const band of strategy.bias_bands || []) {
    const lo = band.min;
    const hi = band.max;
    if ((lo === null || biasMa5 >= lo) && (hi === null || biasMa5 < hi)) {
      return band.score ?? strategy.bias_default_score ?? 10;
    }
  }
  return strategy.bias_default_score ?? 10;
}

function checkHardRules(signal, rsiData, biasData, strategy) {
  const hr = strategy.hard_rules || {};
  const triggered = [];
  if (!(hr.applies_to_signals || []).includes(signal)) return [signal, triggered];

  for (const rule of hr.rules || []) {
    const rtype = rule.type;
    if (rtype === "rsi_zone_equals") {
      if ((rsiData.zone || "") === rule.value) triggered.push(rule.message ?? rule.id ?? "rule");
    } else if (rtype === "bias_ma5_above") {
      const val = biasData.bias_ma5;
      const thr = rule.threshold;
      if (val !== null && val !== undefined && thr !== null && val > thr) {
        const tmpl = rule.message_template;
        if (tmpl) {
          const signed = (val >= 0 ? "+" : "") + val.toFixed(2);
          triggered.push(tmpl.replace("{value:+.2f}", signed));
        } else {
          triggered.push(rule.message ?? rule.id ?? "rule");
        }
      }
    }
  }

  if (triggered.length) signal = hr.downgrade_to || "hold";
  return [signal, triggered];
}

function calcTrendScore(maData, macdData, rsiData, volData, biasData, supportData, strategy) {
  if (!strategy) strategy = loadStrategy();
  const breakdown = {};

  breakdown.trend = strategy.trend_scores[maData.alignment_detail || "consolidation"] ?? strategy.trend_default ?? 12;
  breakdown.bias = scoreBias(biasData.bias_ma5, strategy);
  const volTrend = volData.trend || "normal";
  breakdown.volume = strategy.volume_scores[volTrend] ?? strategy.volume_default ?? 8;
  const macdSignal = macdData.signal || "neutral";
  breakdown.macd = strategy.macd_scores[macdSignal] ?? strategy.macd_default ?? 7;
  const rsiZone = rsiData.zone || "neutral";
  breakdown.rsi = strategy.rsi_scores[rsiZone] ?? strategy.rsi_default ?? 5;

  let supScore = 0;
  if (supportData.support_ma5) supScore += strategy.support_ma5_points ?? 5;
  if (supportData.support_ma10) supScore += strategy.support_ma10_points ?? 5;
  breakdown.support = supScore;

  const total = Object.values(breakdown).reduce((a, b) => a + b, 0);

  const alignmentVal = maData.alignment || "consolidation";
  let signal = "sell";
  for (const rule of strategy.signal_rules || []) {
    const minScore = rule.min_score;
    const reqAlign = rule.require_alignment;
    if (minScore !== undefined && total < minScore) continue;
    if (reqAlign !== undefined && !reqAlign.includes(alignmentVal)) continue;
    signal = rule.signal;
    break;
  }

  const [finalSignal, hardRulesTriggered] = checkHardRules(signal, rsiData, biasData, strategy);
  const signalCn = strategy.signal_cn || {};
  return {
    total,
    breakdown,
    hard_rules_triggered: hardRulesTriggered,
    signal: finalSignal,
    signal_cn: signalCn[finalSignal] ?? finalSignal,
  };
}

// ============================================================
// Analysis pipeline
// ============================================================

async function analyzeStock(code, days = 120, fetchNews = false) {
  const [market, normalized, display] = await classifyStock(code);
  if (market === "unknown") throw new Error(`Cannot classify stock code: ${code}`);

  let raw;
  if (market === "cn_a") raw = await fetchCnA(normalized, days);
  else if (market === "cn_hk") raw = await fetchHk(normalized, days);
  else if (market === "cn_index") raw = await fetchCnIndex(normalized, days);
  else if (market === "us_index") raw = await fetchUsIndex(normalized, days);
  else if (market === "cn_fund") raw = await fetchCnFund(normalized, days);
  else raw = await fetchUs(normalized, days);

  const ohlcv = raw.ohlcv;
  if (!ohlcv || ohlcv.length < 10) {
    throw new Error(`Insufficient data for ${code}: only ${ohlcv?.length || 0} bars`);
  }
  const closes = ohlcv.filter((b) => b.close !== null).map((b) => b.close);
  const volumes = ohlcv.filter((b) => b.volume !== null).map((b) => b.volume);
  if (closes.length < 10) throw new Error(`Insufficient valid close prices for ${code}`);

  const ma = calcMa(closes, [5, 10, 20, 60]);
  const macd = calcMacd(closes);
  const rsi = calcRsi(closes, [6, 12, 24]);
  const vol = calcVolumeAnalysis(volumes, closes);
  const bias = calcBias(closes, ma);
  const support = calcSupport(closes, ma);
  const score = calcTrendScore(ma, macd, rsi, vol, bias, support);

  let news = [];
  if (fetchNews) {
    const stockName = raw.name || display;
    news = await searchNews(stockName, display);
  }

  const result = {
    code: display,
    market,
    is_index: market === "cn_index" || market === "us_index",
    is_fund: market === "cn_fund",
    name: raw.name || display,
    data_source: raw.source || "unknown",
    realtime: raw.realtime || {},
    indicators: { ma, macd, rsi, volume: vol, bias, support },
    trend_score: score,
    recent_bars: ohlcv.slice(-10),
    total_bars: ohlcv.length,
    fetch_time: nowLocalIso(),
  };

  if (market === "cn_fund") {
    result.fund_info = raw.fund_info || {};
    result.holdings = raw.holdings || [];
    const sizeStr = (raw.fund_info || {}).size || "";
    const warnings = [];
    try {
      let sizeWan = null;
      if (sizeStr.includes("亿")) sizeWan = parseFloat(sizeStr.replace("亿", "")) * 10000;
      else if (sizeStr.includes("万")) sizeWan = parseFloat(sizeStr.replace("万", ""));
      if (sizeWan !== null && Number.isFinite(sizeWan)) {
        if (sizeWan < 5000) warnings.push(`清盘红色预警：基金规模 ${sizeStr} 已低于 5000 万元清盘红线`);
        else if (sizeWan < 10000) warnings.push(`清盘黄色预警：基金规模 ${sizeStr} 接近 5000 万元清盘线`);
      }
    } catch {
      // ignore
    }
    if (warnings.length) result.warnings = warnings;
  }
  if (news.length) result.news = news;
  return result;
}

// --- Signal persistence (for backtesting; outcome computation deferred) ---

function persistSignals(results, signalFile, analysisDate) {
  let lines = 0;
  try {
    mkdirSync(path.dirname(signalFile) || ".", { recursive: true });
    let text = "";
    for (const r of results) {
      const ts = r.trend_score || {};
      const realtime = r.realtime || {};
      const rec = {
        date: analysisDate,
        recorded_at: nowLocalIso(),
        code: r.code,
        name: r.name,
        market: r.market,
        price: realtime.price,
        signal: ts.signal,
        signal_cn: ts.signal_cn,
        score_total: ts.total,
        score_breakdown: ts.breakdown,
        hard_rules_triggered: ts.hard_rules_triggered,
        entry: null,
        target: null,
        stop_loss: null,
        outcomes: {},
      };
      text += JSON.stringify(rec) + "\n";
      lines += 1;
    }
    appendFileSync(signalFile, text, "utf8");
    _log(`persisted ${lines} signal(s) to ${signalFile}`);
  } catch (e) {
    _log(`signal persist failed (${e.message || e}) — continuing anyway`);
  }
  return lines;
}

// ============================================================
// Main
// ============================================================

function parseArgs(argv) {
  const args = { stocks: null, days: 120, news: false, holiday: false, date: null, saveSignal: false, signalFile: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--stocks") args.stocks = argv[++i];
    else if (a === "--days") args.days = Number.parseInt(argv[++i], 10) || 120;
    else if (a === "--news") args.news = true;
    else if (a === "--holiday") args.holiday = true;
    else if (a === "--date") args.date = argv[++i];
    else if (a === "--save-signal") args.saveSignal = true;
    else if (a === "--signal-file") args.signalFile = argv[++i];
    else _log(`unknown arg: ${a}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.holiday) {
    let checkDate;
    if (args.date) {
      const m = String(args.date).match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (!m) {
        process.stdout.write(JSON.stringify({ error: `Invalid date format: ${args.date}. Use YYYY-MM-DD format.` }, null, 2) + "\n");
        process.exit(1);
      }
      checkDate = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    } else {
      checkDate = new Date();
    }
    const status = getTradingDayStatus(checkDate);
    const output = {
      check_date: status.date,
      is_trading_day: status.is_trading_day,
      weekday: status.weekday,
      weekday_name: status.weekday_name,
      last_trading_day: status.last_trading_day,
      next_trading_day: status.next_trading_day,
      calendar_source: "weekday fallback (Mon-Fri)",
      check_time: nowLocalIso(),
    };
    process.stdout.write(JSON.stringify(output, null, 2) + "\n");
    return;
  }

  if (!args.stocks) {
    process.stderr.write("error: --stocks is required unless --holiday is used\n");
    process.exit(2);
  }

  const codes = parseStockCodes(args.stocks);
  const sourcesStatus = {
    tushare_token: process.env.TUSHARE_TOKEN ? "configured" : "not set",
    em_http: "available",
    yahoo_http: "available",
    chinese_calendar: "weekday fallback (Mon-Fri)",
    tavily_api: process.env.TAVILY_API_KEY ? "configured" : "not set",
    serpapi: process.env.SERPAPI_KEY ? "configured" : "not set",
  };
  _log(`Data sources: ${JSON.stringify(sourcesStatus)}`);

  const todayStatus = getTradingDayStatus(new Date());
  _log(`Today (${todayStatus.date}) is_trading_day=${todayStatus.is_trading_day} (${todayStatus.weekday_name})`);

  const limit = Math.min(codes.length, 8);
  _log(`Fetching ${codes.length} stocks in parallel (max_workers=${limit})`);

  const results = [];
  const errors = [];
  let idx = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (true) {
      const i = idx++;
      if (i >= codes.length) return;
      const code = codes[i];
      try {
        const result = await withTimeout(analyzeStock(code, args.days, args.news), 120000, `stock ${code}`);
        results.push(result);
      } catch (e) {
        errors.push({ code, error: e.message || String(e), type: e.constructor?.name || "Error" });
      }
    }
  });
  await Promise.all(workers);

  const output = {
    analysis_date: todayStr(),
    analysis_time: nowTimeStr(),
    trading_day_status: todayStatus,
    data_sources: sourcesStatus,
    stocks: results,
    errors,
    total_requested: codes.length,
    total_success: results.length,
  };

  if (args.saveSignal) {
    const signalFile = args.signalFile || path.join(process.cwd(), "signals.jsonl");
    persistSignals(results, signalFile, output.analysis_date);
  }

  process.stdout.write(JSON.stringify(output, null, 2) + "\n");
}

main();
