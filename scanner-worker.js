require("dotenv").config();

const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");

/*
  DEWA SMC SERVER-SIDE SCANNER WORKER V10.5 TRADINGVIEW MATCH
  ------------------------------------------------------------
  Fungsi:
  - Scan otomatis tanpa browser.
  - Timeframe 5m dan 15m.
  - SMC BOS/CHoCH + EMA 9/20 + ATR volatility.
  - Mengirim signal Grade A/A+ ke server utama.
  - Mengirim push notification melalui endpoint server.
  - Mendukung PREPARE, OPEN, dan REVERSE.
  - Market structure mengikuti Pine: ta.pivothigh/ta.pivotlow 20/20.
  - BOS/CHoCH memakai candle body close.
  - PREPARE memakai jarak structure 0.25% + EMA 9/20.
  - ATR memakai Wilder/RMA seperti TradingView ta.atr(14).
  - Volatility memakai ATR14 > SMA(ATR14,20).

  Environment wajib:
  APP_BASE_URL=https://dewa-smc-ai.onrender.com
  WORKER_ADMIN_EMAIL=email admin
  WORKER_ADMIN_PASSWORD=password admin
  TWELVE_DATA_API_KEY_1=...
  TWELVE_DATA_API_KEY_2=...
  TWELVE_DATA_API_KEY_3=...

  Environment opsional:
  WORKER_ENABLED=true
  WORKER_SCAN_SECONDS=120
  WORKER_PAIRS=XAU/USD,BTC/USD,ETH/USD,EUR/USD,GBP/USD
  WORKER_TFS=5,15
  WORKER_OUTPUTSIZE=180
*/

const APP_BASE_URL = String(
  process.env.APP_BASE_URL || "https://dewa-smc-ai.onrender.com"
).replace(/\/+$/, "");

const ADMIN_EMAIL = String(process.env.WORKER_ADMIN_EMAIL || "").trim();
const ADMIN_PASSWORD = String(process.env.WORKER_ADMIN_PASSWORD || "");
const ENABLED = String(process.env.WORKER_ENABLED || "true").toLowerCase() === "true";
const SCAN_SECONDS = Math.max(60, Number(process.env.WORKER_SCAN_SECONDS || 120));
const OUTPUT_SIZE = Math.max(80, Math.min(500, Number(process.env.WORKER_OUTPUTSIZE || 180)));

const DEFAULT_PAIRS = String(
  process.env.WORKER_PAIRS ||
  "XAU/USD,BTC/USD,ETH/USD,EUR/USD,GBP/USD"
)
  .split(",")
  .map(x => x.trim().toUpperCase())
  .filter(Boolean);

const DEFAULT_TFS = String(process.env.WORKER_TFS || "5,15")
  .split(",")
  .map(x => x.trim())
  .filter(x => x === "5" || x === "15");


const DEFAULT_PAIR_SETTINGS = DEFAULT_PAIRS.map((symbol, index) => ({
  symbol,
  dataSymbol: symbol,
  timeframes: [...DEFAULT_TFS],
  enabled: true,
  priority: "NORMAL",
  structurePeriod: 20,
  prepareDistancePct: 0.25,
  volatilityEnabled: true,
  minRrr: 1.5,
  scanOrder: index
}));

let ACTIVE_PAIR_SETTINGS = [...DEFAULT_PAIR_SETTINGS];
let LAST_CONFIG_REFRESH_AT = null;

function normalizePriority(value) {
  const priority = String(value || "NORMAL").trim().toUpperCase();
  return ["HIGH", "NORMAL", "LOW"].includes(priority) ? priority : "NORMAL";
}

function priorityWeight(value) {
  return { HIGH: 0, NORMAL: 1, LOW: 2 }[normalizePriority(value)];
}

function normalizeWorkerPair(raw, index = 0) {
  const symbol = String(
    raw?.symbol || raw?.displaySymbol || raw?.dataSymbol || raw?.data_symbol || ""
  ).trim().toUpperCase();

  const dataSymbol = String(
    raw?.dataSymbol || raw?.data_symbol || symbol
  ).trim().toUpperCase();

  const rawTfs = Array.isArray(raw?.timeframes)
    ? raw.timeframes
    : DEFAULT_TFS;

  const timeframes = [...new Set(
    rawTfs.map(String).filter(tf => tf === "5" || tf === "15")
  )];

  return {
    symbol,
    dataSymbol,
    timeframes: timeframes.length ? timeframes : [...DEFAULT_TFS],
    enabled: raw?.enabled !== false,
    priority: normalizePriority(raw?.priority),
    structurePeriod: Math.min(
      60,
      Math.max(2, Number(raw?.structurePeriod ?? raw?.structure_period ?? 20))
    ),
    prepareDistancePct: Math.min(
      5,
      Math.max(
        0.00001,
        Number(raw?.prepareDistancePct ?? raw?.prepare_distance_pct ?? 0.25)
      )
    ),
    volatilityEnabled:
      (raw?.volatilityEnabled ?? raw?.volatility_enabled) !== false,
    minRrr: Math.max(
      0.01,
      Number(raw?.minRrr ?? raw?.min_rrr ?? 1.5)
    ),
    scanOrder: Number(raw?.scanOrder ?? raw?.scan_order ?? index)
  };
}

function sortPairSettings(settings) {
  return [...settings].sort((a, b) => {
    const priorityDiff = priorityWeight(a.priority) - priorityWeight(b.priority);
    if (priorityDiff !== 0) return priorityDiff;

    const orderDiff = Number(a.scanOrder || 0) - Number(b.scanOrder || 0);
    if (orderDiff !== 0) return orderDiff;

    return a.symbol.localeCompare(b.symbol);
  });
}

async function refreshWorkerConfig() {
  try {
    const config = await authorizedApi("/api/worker/config");

    let nextSettings = [];

    if (Array.isArray(config.pairSettings) && config.pairSettings.length) {
      nextSettings = config.pairSettings
        .map(normalizeWorkerPair)
        .filter(item => item.enabled && item.symbol && item.dataSymbol);
    } else if (Array.isArray(config.pairs) && config.pairs.length) {
      const globalTfs = Array.isArray(config.timeframes)
        ? config.timeframes.map(String).filter(tf => tf === "5" || tf === "15")
        : DEFAULT_TFS;

      nextSettings = config.pairs
        .map((pair, index) =>
          normalizeWorkerPair(
            {
              symbol: pair,
              dataSymbol: pair,
              timeframes: globalTfs,
              enabled: true,
              scanOrder: index
            },
            index
          )
        )
        .filter(item => item.symbol && item.dataSymbol);
    }

    if (!nextSettings.length) {
      throw new Error("Konfigurasi pair aktif kosong");
    }

    ACTIVE_PAIR_SETTINGS = sortPairSettings(nextSettings);
    LAST_CONFIG_REFRESH_AT = new Date().toISOString();

    console.log(
      "[WORKER CONFIG]",
      "source=SUPABASE",
      "pairs=" + ACTIVE_PAIR_SETTINGS.length,
      "refreshedAt=" + LAST_CONFIG_REFRESH_AT
    );

    for (const item of ACTIVE_PAIR_SETTINGS) {
      console.log(
        "[PAIR CONFIG]",
        item.symbol,
        "data=" + item.dataSymbol,
        "tf=" + item.timeframes.join(","),
        "priority=" + item.priority,
        "structure=" + item.structurePeriod,
        "prepare=" + item.prepareDistancePct + "%",
        "volatility=" + (item.volatilityEnabled ? "ON" : "OFF"),
        "minRRR=" + item.minRrr,
        "order=" + item.scanOrder
      );
    }
  } catch (error) {
    console.warn(
      "[WORKER CONFIG] Gagal membaca konfigurasi Supabase. " +
      "Memakai cache terakhir/ENV fallback:",
      error.message
    );

    if (!ACTIVE_PAIR_SETTINGS.length) {
      ACTIVE_PAIR_SETTINGS = [...DEFAULT_PAIR_SETTINGS];
    }
  }
}

const API_KEYS = Object.keys(process.env)
  .filter(k => k.startsWith("TWELVE_DATA_API_KEY_"))
  .sort((a, b) => {
    const na = Number(a.match(/\d+$/)?.[0] || 0);
    const nb = Number(b.match(/\d+$/)?.[0] || 0);
    return na - nb;
  })
  .map(k => process.env[k])
  .filter(Boolean);

const STATE_FILE = path.join(__dirname, "data", "scanner-worker-state.json");

let authToken = "";
let keyIndex = 0;
let running = false;

const API_KEY_BLOCKED_UNTIL = new Map();

function nextUtcMidnight(){
  const now = new Date();

  return Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0,
    1,
    0
  );
}

function isApiKeyBlocked(index){
  const blockedUntil = API_KEY_BLOCKED_UNTIL.get(index) || 0;

  if(blockedUntil <= Date.now()){
    API_KEY_BLOCKED_UNTIL.delete(index);
    return false;
  }

  return true;
}

function blockApiKey(index, errorMessage){
  const message = String(errorMessage || "").toLowerCase();

  const isDailyLimit =
    message.includes("credits for the day") ||
    message.includes("daily") ||
    message.includes("current limit being");

  const blockedUntil = isDailyLimit
    ? nextUtcMidnight()
    : Date.now() + 70 * 1000;

  API_KEY_BLOCKED_UNTIL.set(index, blockedUntil);

  console.warn(
    "[API KEY BLOCKED]",
    "key",
    index + 1,
    "sampai",
    new Date(blockedUntil).toISOString(),
    isDailyLimit ? "(daily limit)" : "(minute limit)"
  );
}

function ensureStateDir() {
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadState() {
  ensureStateDir();
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { lastSignalByPairTf: {}, lastDirectionByPairTf: {} };
  }
}

function saveState(state) {
  ensureStateDir();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

const state = loadState();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function intervalFromTf(tf) {
  return tf === "15" ? "15min" : "5min";
}

function tfLabel(tf) {
  return tf + "m";
}

function fmtPrice(x) {
  if (!Number.isFinite(Number(x))) return "-";
  return Number(x).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

function emaSeries(values, period) {
  if (!Array.isArray(values) || values.length === 0 || period <= 0) return [];

  const alpha = 2 / (period + 1);
  const output = [];
  let value = Number(values[0]);

  output.push(value);

  for (let i = 1; i < values.length; i++) {
    const source = Number(values[i]);
    value = alpha * source + (1 - alpha) * value;
    output.push(value);
  }

  return output;
}

function ema(values, period) {
  const series = emaSeries(values, period);
  return series.length ? series[series.length - 1] : NaN;
}

function sma(values, period) {
  if (!Array.isArray(values) || values.length < period || period <= 0) {
    return NaN;
  }

  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function trueRangeSeries(candles) {
  if (!Array.isArray(candles) || candles.length === 0) return [];

  const output = [];

  for (let i = 0; i < candles.length; i++) {
    const current = candles[i];

    if (i === 0) {
      output.push(current.high - current.low);
      continue;
    }

    const previousClose = candles[i - 1].close;

    output.push(
      Math.max(
        current.high - current.low,
        Math.abs(current.high - previousClose),
        Math.abs(current.low - previousClose)
      )
    );
  }

  return output;
}

// TradingView ta.rma(): seed memakai SMA(period), lalu Wilder smoothing.
function rmaSeries(values, period) {
  if (!Array.isArray(values) || values.length < period || period <= 0) {
    return [];
  }

  const output = new Array(values.length).fill(NaN);
  let value =
    values.slice(0, period).reduce((sum, item) => sum + item, 0) / period;

  output[period - 1] = value;

  for (let i = period; i < values.length; i++) {
    value = (value * (period - 1) + values[i]) / period;
    output[i] = value;
  }

  return output;
}

// TradingView ta.atr(period) = ta.rma(true range, period).
function atrSeries(candles, period = 14) {
  return rmaSeries(trueRangeSeries(candles), period);
}

function atr(candles, period = 14) {
  const values = atrSeries(candles, period).filter(Number.isFinite);
  return values.length ? values[values.length - 1] : NaN;
}

function getGrade(score) {
  if (score >= 8) return "A+";
  if (score >= 6.5) return "A";
  if (score >= 5) return "B";
  return "C";
}

// -----------------------------------------------------------------------------
// TradingView/Pine compatibility helpers
// Pine reference:
//   ta.pivothigh(high, structurePeriod, structurePeriod)
//   ta.pivotlow(low, structurePeriod, structurePeriod)
// -----------------------------------------------------------------------------
function pivotHighAt(candles, index, left, right) {
  if (index - left < 0 || index + right >= candles.length) return null;

  const value = candles[index].high;

  for (let i = index - left; i <= index + right; i++) {
    if (i === index) continue;
    if (candles[i].high >= value) return null;
  }

  return value;
}

function pivotLowAt(candles, index, left, right) {
  if (index - left < 0 || index + right >= candles.length) return null;

  const value = candles[index].low;

  for (let i = index - left; i <= index + right; i++) {
    if (i === index) continue;
    if (candles[i].low <= value) return null;
  }

  return value;
}

function buildTvStructure(candles, structurePeriod) {
  let lastHigh = NaN;
  let lastLow = NaN;
  let lastHighIndex = -1;
  let lastLowIndex = -1;

  let highBreakPending = false;
  let lowBreakPending = false;
  let trendDirection = 0;

  let lastBreak = null;

  for (let i = 0; i < candles.length; i++) {
    // Pine confirms a pivot only after `structurePeriod` right-hand bars.
    const pivotIndex = i - structurePeriod;

    if (pivotIndex >= 0) {
      const ph = pivotHighAt(
        candles,
        pivotIndex,
        structurePeriod,
        structurePeriod
      );

      const pl = pivotLowAt(
        candles,
        pivotIndex,
        structurePeriod,
        structurePeriod
      );

      if (ph !== null) {
        lastHigh = ph;
        lastHighIndex = pivotIndex;
        highBreakPending = true;
      }

      if (pl !== null) {
        lastLow = pl;
        lastLowIndex = pivotIndex;
        lowBreakPending = true;
      }
    }

    const candle = candles[i];
    let highBroken = false;
    let lowBroken = false;

    // Pine confirmationType = "Body":
    // bullish break only if close > structure high,
    // bearish break only if close < structure low.
    if (
      highBreakPending &&
      Number.isFinite(lastHigh) &&
      candle.close > lastHigh
    ) {
      highBroken = true;
      highBreakPending = false;
    }

    if (
      lowBreakPending &&
      Number.isFinite(lastLow) &&
      candle.close < lastLow
    ) {
      lowBroken = true;
      lowBreakPending = false;
    }

    const previousTrend = trendDirection;

    // Pine uses if/else-if, therefore bullish gets priority
    // only in the practically impossible case both are true.
    if (highBroken) {
      trendDirection = 1;
    } else if (lowBroken) {
      trendDirection = -1;
    }

    const choch =
      (previousTrend === -1 && trendDirection === 1) ||
      (previousTrend === 1 && trendDirection === -1);

    if (highBroken) {
      lastBreak = {
        index: i,
        direction: "LONG",
        type: choch ? "CHoCH BULLISH" : "BOS BULLISH",
        structure: lastHigh,
        structureIndex: lastHighIndex,
        candleTime: candle.time
      };
    } else if (lowBroken) {
      lastBreak = {
        index: i,
        direction: "SHORT",
        type: choch ? "CHoCH BEARISH" : "BOS BEARISH",
        structure: lastLow,
        structureIndex: lastLowIndex,
        candleTime: candle.time
      };
    }
  }

  return {
    lastHigh,
    lastLow,
    lastHighIndex,
    lastLowIndex,
    highBreakPending,
    lowBreakPending,
    trendDirection,
    lastBreak
  };
}

function targetLevels(direction, entry, atr14) {
  const targetRange = atr14 * 2.0;

  if (direction === "LONG") {
    return {
      targetRange,
      tp1: entry + targetRange * 0.8,
      tp2: entry + targetRange * 1.6,
      tp3: entry + targetRange * 2.8,
      sl: entry - targetRange * 1.2
    };
  }

  return {
    targetRange,
    tp1: entry - targetRange * 0.8,
    tp2: entry - targetRange * 1.6,
    tp3: entry - targetRange * 2.8,
    sl: entry + targetRange * 1.2
  };
}

function analyzeSmc(pair, tf, candles, pairConfig = {}) {
  /*
    Twelve Data normally includes the currently-forming candle as the final item.

    TradingView behavior we reproduce:
    - BOS/CHoCH: only confirmed from a CLOSED candle.
    - PREPARE: may use the latest/current price before the breakout,
      which is what allows EA to place the pending order early.
  */
  if (!Array.isArray(candles) || candles.length < 90) {
    return { valid: false, reason: "DATA LOW" };
  }

  const structurePeriod = Math.min(
    50,
    Math.max(5, Number(pairConfig.structurePeriod || 20))
  );

  const prepareDistancePct = Math.min(
    5,
    Math.max(
      0.00001,
      Number(pairConfig.prepareDistancePct || 0.25)
    )
  );

  const current = candles[candles.length - 1];
  const closed = candles.slice(0, -1);

  if (closed.length < structurePeriod * 2 + 30) {
    return { valid: false, reason: "DATA LOW FOR PIVOT" };
  }

  // Build structure using CLOSED candles only.
  const structure = buildTvStructure(closed, structurePeriod);

  // Indicator calculations.
  // For confirmed ENTRY use closed-bar values.
  const closedCloses = closed.map(c => c.close);
  const closedEma9 = ema(closedCloses, 9);
  const closedEma20 = ema(closedCloses, 20);

  const closedAtrFull = atrSeries(closed, 14);
  const closedAtrFinite = closedAtrFull.filter(Number.isFinite);
  const closedAtr14 = closedAtrFinite.length
    ? closedAtrFinite[closedAtrFinite.length - 1]
    : NaN;
  const closedAtrSma20 = sma(closedAtrFinite, 20);

  // For PREPARE TradingView recalculates on the live candle.
  const liveCloses = candles.map(c => c.close);
  const liveEma9 = ema(liveCloses, 9);
  const liveEma20 = ema(liveCloses, 20);

  const liveAtrFull = atrSeries(candles, 14);
  const liveAtrFinite = liveAtrFull.filter(Number.isFinite);
  const liveAtr14 = liveAtrFinite.length
    ? liveAtrFinite[liveAtrFinite.length - 1]
    : NaN;
  const liveAtrSma20 = sma(liveAtrFinite, 20);

  const volatilityEnabled = pairConfig.volatilityEnabled !== false;

  const closedVolatilityOk =
    !volatilityEnabled ||
    (
      Number.isFinite(closedAtr14) &&
      Number.isFinite(closedAtrSma20) &&
      closedAtr14 > closedAtrSma20
    );

  const liveVolatilityOk =
    !volatilityEnabled ||
    (
      Number.isFinite(liveAtr14) &&
      Number.isFinite(liveAtrSma20) &&
      liveAtr14 > liveAtrSma20
    );

  const lastClosed = closed[closed.length - 1];

  const closedEmaLong =
    closedEma9 > closedEma20 &&
    lastClosed.close > closedEma9;

  const closedEmaShort =
    closedEma9 < closedEma20 &&
    lastClosed.close < closedEma9;

  const liveEmaLong =
    liveEma9 > liveEma20 &&
    current.close > liveEma9;

  const liveEmaShort =
    liveEma9 < liveEma20 &&
    current.close < liveEma9;

  const rrr = {
    tp1: 0.8 / 1.2,
    tp2: 1.6 / 1.2,
    tp3: 2.8 / 1.2
  };

  const minRrr = Math.max(
    0.01,
    Number(pairConfig.minRrr || 1.5)
  );

  // ===========================================================================
  // 1) CONFIRMED BOS / CHoCH
  // ===========================================================================
  const freshBreak =
    structure.lastBreak &&
    structure.lastBreak.index === closed.length - 1
      ? structure.lastBreak
      : null;

  if (freshBreak) {
    const emaOk =
      freshBreak.direction === "LONG"
        ? closedEmaLong
        : closedEmaShort;

    // DEWA execution rule: confirmed OPEN must pass EMA + volatility.
    if (!emaOk) {
      return {
        valid: false,
        reason: "ENTRY EMA NOT CONFIRMED",
        direction: freshBreak.direction,
        mainSignal: freshBreak.type,
        emaOk: false,
        volatilityOk: closedVolatilityOk
      };
    }

    if (!closedVolatilityOk) {
      return {
        valid: false,
        reason: "ENTRY VOLATILITY LOW",
        direction: freshBreak.direction,
        mainSignal: freshBreak.type,
        emaOk: true,
        volatilityOk: false
      };
    }

    if (rrr.tp3 < minRrr) {
      return {
        valid: false,
        reason: "RRR BELOW MINIMUM",
        minRrr,
        maxRrr: rrr.tp3
      };
    }

    const entry = freshBreak.structure;
    const levels = targetLevels(
      freshBreak.direction,
      entry,
      closedAtr14
    );

    const stateKey = pair + "|" + tf;
    const previousDirection =
      state.lastDirectionByPairTf[stateKey];

    let finalSignal =
      freshBreak.direction === "LONG"
        ? "OPEN LONG"
        : "OPEN SHORT";

    if (
      previousDirection &&
      previousDirection !== freshBreak.direction
    ) {
      finalSignal =
        freshBreak.direction === "LONG"
          ? "REVERSE LONG"
          : "REVERSE SHORT";
    }

    const score =
      2 +
      (freshBreak.type.startsWith("CHoCH") ? 1 : 0) +
      1.5 + // EMA confirmed
      1 +   // volatility
      1.5 + // EMA direction
      1;    // close side

    const grade = getGrade(score);

    const eventKey = [
      "ENTRY",
      pair,
      tfLabel(tf),
      finalSignal,
      freshBreak.candleTime,
      fmtPrice(entry)
    ].join("|");

    return {
      valid: true,
      key: eventKey,
      pair,
      tf: tfLabel(tf),
      signal: finalSignal,
      status: finalSignal,
      engine: "SMC",
      grade,
      score,
      entry,
      tp1: levels.tp1,
      tp2: levels.tp2,
      tp3: levels.tp3,
      sl: levels.sl,
      atr: closedAtr14,
      atrSma20: closedAtrSma20,
      targetRange: levels.targetRange,
      ema9: closedEma9,
      ema20: closedEma20,
      emaConfirm: "YES",
      volatilityOk: closedVolatilityOk,
      volatilityEnabled,
      structurePeriod,
      prepareDistancePct,
      minRrr,
      rrr,
      priority: pairConfig.priority || "NORMAL",
      scanOrder: Number(pairConfig.scanOrder || 0),
      dataSymbol: pairConfig.dataSymbol || pair,
      structureHigh: structure.lastHigh,
      structureLow: structure.lastLow,
      mainSignal: freshBreak.type,
      candleTime: freshBreak.candleTime,
      direction: freshBreak.direction,
      sourceMode: "TV_MATCH_ENTRY",
      createdAt: new Date().toISOString()
    };
  }

  // ===========================================================================
  // 2) PREPARE BEFORE BREAKOUT
  //
  // Pine:
  // prepLongRaw  = abs(close-structHigh) <= structHigh*0.25% && close<structHigh
  // prepShortRaw = abs(close-structLow)  <= structLow *0.25% && close>structLow
  // PREPARE also requires EMA alignment.
  //
  // Extension for EA:
  // Pine only visualizes PREPARE and does not emit target JSON for it.
  // We derive TP/SL from the SAME ATR×2 formulas so EA can place pending order.
  // ===========================================================================
  const longThreshold =
    Number.isFinite(structure.lastHigh)
      ? Math.abs(structure.lastHigh) * (prepareDistancePct / 100)
      : NaN;

  const shortThreshold =
    Number.isFinite(structure.lastLow)
      ? Math.abs(structure.lastLow) * (prepareDistancePct / 100)
      : NaN;

  const prepLongRaw =
    structure.highBreakPending &&
    Number.isFinite(structure.lastHigh) &&
    current.close < structure.lastHigh &&
    Math.abs(current.close - structure.lastHigh) <= longThreshold;

  const prepShortRaw =
    structure.lowBreakPending &&
    Number.isFinite(structure.lastLow) &&
    current.close > structure.lastLow &&
    Math.abs(current.close - structure.lastLow) <= shortThreshold;

  const prepLong = prepLongRaw && liveEmaLong;
  const prepShort = prepShortRaw && liveEmaShort;

  let prepareDirection = null;

  if (prepLong && prepShort) {
    // Rare case: choose the structure level nearest to current price.
    const distLong =
      Math.abs(current.close - structure.lastHigh);
    const distShort =
      Math.abs(current.close - structure.lastLow);

    prepareDirection =
      distLong <= distShort ? "LONG" : "SHORT";
  } else if (prepLong) {
    prepareDirection = "LONG";
  } else if (prepShort) {
    prepareDirection = "SHORT";
  }

  if (!prepareDirection) {
    return {
      valid: false,
      reason: "NO FRESH BOS/CHoCH OR PREPARE",
      structureHigh: structure.lastHigh,
      structureLow: structure.lastLow,
      liveClose: current.close,
      ema9: liveEma9,
      ema20: liveEma20,
      volatilityOk: liveVolatilityOk
    };
  }

  // Do not arm an executable pending setup while volatility is low.
  if (!liveVolatilityOk) {
    return {
      valid: false,
      reason: "PREPARE VOLATILITY LOW",
      direction: prepareDirection,
      structureHigh: structure.lastHigh,
      structureLow: structure.lastLow,
      emaOk: true,
      volatilityOk: false
    };
  }

  if (rrr.tp3 < minRrr) {
    return {
      valid: false,
      reason: "RRR BELOW MINIMUM",
      minRrr,
      maxRrr: rrr.tp3
    };
  }

  const prepareEntry =
    prepareDirection === "LONG"
      ? structure.lastHigh
      : structure.lastLow;

  const prepareLevels = targetLevels(
    prepareDirection,
    prepareEntry,
    liveAtr14
  );

  const prepareSignal =
    prepareDirection === "LONG"
      ? "PREPARE LONG"
      : "PREPARE SHORT";

  /*
    Pine anti-spam compares structure price with lastAlertPrice.
    For PREPARE we make the key structure-based (NOT candle-time based),
    so the same structure does not create another pending order every scan.
  */
  const eventKey = [
    "PREPARE",
    pair,
    tfLabel(tf),
    prepareSignal,
    fmtPrice(prepareEntry)
  ].join("|");

  const prepareScore =
    2 +   // valid structure
    1.5 + // EMA confirmed
    1 +   // volatility
    1.5 + // EMA direction
    1;    // price close side

  const prepareGrade = getGrade(prepareScore);

  return {
    valid: true,
    key: eventKey,
    pair,
    tf: tfLabel(tf),
    signal: prepareSignal,
    status: prepareSignal,
    engine: "SMC",
    grade: prepareGrade,
    score: prepareScore,
    entry: prepareEntry,
    tp1: prepareLevels.tp1,
    tp2: prepareLevels.tp2,
    tp3: prepareLevels.tp3,
    sl: prepareLevels.sl,
    atr: liveAtr14,
    atrSma20: liveAtrSma20,
    targetRange: prepareLevels.targetRange,
    ema9: liveEma9,
    ema20: liveEma20,
    emaConfirm: "YES",
    volatilityOk: liveVolatilityOk,
    volatilityEnabled,
    structurePeriod,
    prepareDistancePct,
    minRrr,
    rrr,
    priority: pairConfig.priority || "NORMAL",
    scanOrder: Number(pairConfig.scanOrder || 0),
    dataSymbol: pairConfig.dataSymbol || pair,
    structureHigh: structure.lastHigh,
    structureLow: structure.lastLow,
    mainSignal: "PREPARE",
    candleTime: current.time,
    direction: prepareDirection,
    currentPrice: current.close,
    distanceToEntryPct:
      Math.abs(current.close - prepareEntry) /
      Math.abs(prepareEntry) *
      100,
    sourceMode: "TV_MATCH_PREPARE",
    createdAt: new Date().toISOString()
  };
}

async function getJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();

  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(
      "Respons bukan JSON (" + response.status + "): " + text.slice(0, 120)
    );
  }

  if (!response.ok || data.error) {
    const error = new Error(data.error || "HTTP " + response.status);
    error.status = response.status;
    throw error;
  }

  return data;
}

async function login() {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    throw new Error(
      "WORKER_ADMIN_EMAIL / WORKER_ADMIN_PASSWORD belum diisi"
    );
  }

  const data = await getJson(APP_BASE_URL + "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD
    })
  });

  authToken = data.token;
  console.log("[WORKER] Login admin berhasil:", ADMIN_EMAIL);
}

async function authorizedApi(pathname, options = {}, retry = true) {
  if (!authToken) await login();

  try {
    return await getJson(APP_BASE_URL + pathname, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + authToken,
        ...(options.headers || {})
      }
    });
  } catch (error) {
    if (retry && (error.status === 401 || error.status === 403)) {
      authToken = "";
      await login();
      return authorizedApi(pathname, options, false);
    }
    throw error;
  }
}
async function fetchCandles(pair, tf) {
  if (!API_KEYS.length) {
    throw new Error("Twelve Data API key belum diisi");
  }

  let lastError = null;
  let availableKeyFound = false;

  for (let attempt = 0; attempt < API_KEYS.length; attempt++) {
    const currentIndex = keyIndex++ % API_KEYS.length;

    if (isApiKeyBlocked(currentIndex)) {
      const blockedUntil = API_KEY_BLOCKED_UNTIL.get(currentIndex);

      console.log(
        "[API SKIP]",
        "key",
        currentIndex + 1,
        "masih diblokir sampai",
        new Date(blockedUntil).toISOString()
      );

      continue;
    }

    availableKeyFound = true;

    const apiKey = API_KEYS[currentIndex];
    const url = new URL("https://api.twelvedata.com/time_series");

    url.searchParams.set("symbol", pair);
    url.searchParams.set("interval", intervalFromTf(tf));
    url.searchParams.set("outputsize", String(OUTPUT_SIZE));
    url.searchParams.set("format", "JSON");
    url.searchParams.set("apikey", apiKey);

    console.log(
      "[API]",
      pair,
      tfLabel(tf),
      "key",
      currentIndex + 1,
      "of",
      API_KEYS.length
    );

    try {
      const data = await getJson(url.toString());

      if (data.status === "error") {
        throw new Error(data.message || "Twelve Data error");
      }

      const candles = (data.values || [])
        .map(v => ({
          time: v.datetime,
          open: Number(v.open),
          high: Number(v.high),
          low: Number(v.low),
          close: Number(v.close),
          volume: Number(v.volume || 1)
        }))
        .filter(c =>
          Number.isFinite(c.open) &&
          Number.isFinite(c.high) &&
          Number.isFinite(c.low) &&
          Number.isFinite(c.close)
        )
        .reverse();

      if (candles.length < 70) {
        throw new Error("Candle kurang dari 70");
      }

      return candles;

    } catch (error) {
      lastError = error;

      const message = String(error.message || "");

      if (
        error.status === 429 ||
        message.includes("429") ||
        message.toLowerCase().includes("credits for the day")
      ) {
        blockApiKey(currentIndex, message);
        continue;
      }

      throw error;
    }
  }

  if (!availableKeyFound) {
    const blockedTimes = [...API_KEY_BLOCKED_UNTIL.values()];
    const nearest = blockedTimes.length
      ? Math.min(...blockedTimes)
      : null;

    throw new Error(
      nearest
        ? "Semua API key sedang diblokir sampai minimal " +
          new Date(nearest).toISOString()
        : "Semua API key sedang diblokir"
    );
  }

  throw new Error(
    "Semua Twelve Data API key gagal atau terkena limit. " +
    (lastError ? lastError.message : "")
  );
}
async function saveSignal(signal) {
  return authorizedApi("/api/signals/upsert", {
    method: "POST",
    body: JSON.stringify(signal)
  });
}

async function sendNotification(signal) {
  return authorizedApi("/api/push/broadcast", {
    method: "POST",
    body: JSON.stringify({
      pair: signal.pair,
      signal: signal.signal,
      grade: signal.grade,
      engine: signal.engine,
      entry: fmtPrice(signal.entry),
      tp1: fmtPrice(signal.tp1),
      tp2: fmtPrice(signal.tp2),
      tp3: fmtPrice(signal.tp3),
      sl: fmtPrice(signal.sl),
      emaConfirm: signal.emaConfirm,
      volatility: signal.volatilityOk ? "OK" : "LOW",
      mainSignal: signal.mainSignal,
      sourceMode: signal.sourceMode
    })
  });
}

async function processPairTf(pairConfig, tf) {
  const pair = pairConfig.symbol;
  const candles = await fetchCandles(pairConfig.dataSymbol, tf);
  const signal = analyzeSmc(pair, tf, candles, pairConfig);

  if (!signal.valid) {
    console.log(
      "[SCAN]",
      pair,
      tfLabel(tf),
      signal.reason,
      signal.grade || ""
    );
    return;
  }

  const stateKey = pair + "|" + tf;
  const lastKey = state.lastSignalByPairTf[stateKey];

  if (lastKey === signal.key) {
    console.log("[SCAN]", pair, tfLabel(tf), "signal sudah pernah dikirim");
    return;
  }

  await saveSignal(signal);
  await sendNotification(signal);

  state.lastSignalByPairTf[stateKey] = signal.key;
  state.lastDirectionByPairTf[stateKey] = signal.direction;
  saveState(state);

  console.log(
    "[SIGNAL]",
    signal.pair,
    signal.tf,
    signal.signal,
    signal.grade,
    "Entry",
    fmtPrice(signal.entry),
    "SL",
    fmtPrice(signal.sl),
    "TP1",
    fmtPrice(signal.tp1),
    "EMA",
    signal.emaConfirm || "-",
    "VOL",
    signal.volatilityOk ? "OK" : "LOW",
    signal.sourceMode || ""
  );
}

async function runAutoScanner() {
  if (running) {
    console.log("[WORKER] Scan sebelumnya masih berjalan, skip.");
    return;
  }

  running = true;
  const started = Date.now();
  const scanPlan = [];

  for (const pairConfig of ACTIVE_PAIR_SETTINGS) {
    for (const tf of pairConfig.timeframes) {
      if (tf === "5" || tf === "15") {
        scanPlan.push({ pairConfig, tf });
      }
    }
  }

  console.log(
    "\n[WORKER] Scan mulai",
    new Date().toISOString(),
    "jobs=" + scanPlan.length,
    "pairs=" + ACTIVE_PAIR_SETTINGS.length,
    "configRefreshedAt=" + (LAST_CONFIG_REFRESH_AT || "ENV")
  );

  try {
    for (const job of scanPlan) {
      const { pairConfig, tf } = job;

      try {
        await processPairTf(pairConfig, tf);
      } catch (error) {
        console.error(
          "[SCAN ERROR]",
          pairConfig.symbol,
          tfLabel(tf),
          error.message
        );
      }

      // Mengurangi risiko rate limit Twelve Data.
      await sleep(1500);
    }
  } finally {
    running = false;
    console.log(
      "[WORKER] Scan selesai dalam",
      Math.round((Date.now() - started) / 1000),
      "detik"
    );
  }
}

async function main() {
  console.log("==============================================");
  console.log("DEWA SMC SERVER SCANNER WORKER V10.5 TRADINGVIEW MATCH");
  console.log("APP:", APP_BASE_URL);
  console.log("PAIR ENV FALLBACK:", DEFAULT_PAIRS.join(", "));
  console.log("TF ENV FALLBACK:", DEFAULT_TFS.join(", "));
  console.log("INTERVAL:", SCAN_SECONDS, "detik");
  console.log("==============================================");

  if (!ENABLED) {
    console.log("[WORKER] WORKER_ENABLED=false. Worker tidak dijalankan.");
    return;
  }

  if (!API_KEYS.length) {
    throw new Error("Tidak ada TWELVE_DATA_API_KEY_*");
  }

  await login();
  await refreshWorkerConfig();
  await runAutoScanner();

  setInterval(() => {
    refreshWorkerConfig()
      .then(() => runAutoScanner())
      .catch(error => {
      console.error("[WORKER FATAL LOOP]", error);
      });
  }, SCAN_SECONDS * 1000);
}

main().catch(error => {
  console.error("[WORKER START ERROR]", error);
  process.exit(1);
});
