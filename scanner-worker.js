require("dotenv").config();

const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");

/*
  DEWA SMC SERVER-SIDE SCANNER WORKER V1
  ------------------------------------------------------------
  Fungsi:
  - Scan otomatis tanpa browser.
  - Timeframe 5m dan 15m.
  - SMC BOS/CHoCH + EMA 9/20 + ATR volatility.
  - Mengirim signal Grade A/A+ ke server utama.
  - Mengirim push notification melalui endpoint server.
  - Mendukung OPEN dan REVERSE.

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

const PAIRS = String(
  process.env.WORKER_PAIRS ||
  "XAU/USD,BTC/USD,ETH/USD,EUR/USD,GBP/USD"
)
  .split(",")
  .map(x => x.trim().toUpperCase())
  .filter(Boolean);

const TFS = String(process.env.WORKER_TFS || "5,15")
  .split(",")
  .map(x => x.trim())
  .filter(x => x === "5" || x === "15");

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

function ema(values, period) {
  if (!values.length) return NaN;
  const k = 2 / (period + 1);
  let result = values[0];
  for (let i = 1; i < values.length; i++) {
    result = values[i] * k + result * (1 - k);
  }
  return result;
}

function sma(values, period) {
  const slice = values.slice(-period);
  if (!slice.length) return NaN;
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function atr(candles, period = 14) {
  const tr = [];
  for (let i = 1; i < candles.length; i++) {
    tr.push(
      Math.max(
        candles[i].high - candles[i].low,
        Math.abs(candles[i].high - candles[i - 1].close),
        Math.abs(candles[i].low - candles[i - 1].close)
      )
    );
  }
  const slice = tr.slice(-period);
  return slice.length
    ? slice.reduce((a, b) => a + b, 0) / slice.length
    : 0;
}

function atrSeries(candles, period = 14) {
  const values = [];
  for (let i = period + 1; i <= candles.length; i++) {
    values.push(atr(candles.slice(0, i), period));
  }
  return values.filter(Number.isFinite);
}

function getGrade(score) {
  if (score >= 8) return "A+";
  if (score >= 6.5) return "A";
  if (score >= 5) return "B";
  return "C";
}

function pivotHighAt(candles, index, left, right) {
  if (index - left < 0 || index + right >= candles.length) return null;
  const value = candles[index].high;
  for (let i = index - left; i <= index + right; i++) {
    if (i !== index && candles[i].high >= value) return null;
  }
  return value;
}

function pivotLowAt(candles, index, left, right) {
  if (index - left < 0 || index + right >= candles.length) return null;
  const value = candles[index].low;
  for (let i = index - left; i <= index + right; i++) {
    if (i !== index && candles[i].low <= value) return null;
  }
  return value;
}

function analyzeSmc(pair, tf, candles) {
  // Candle terakhir dari Twelve Data bisa masih berjalan.
  const closed = candles.slice(0, -1);
  if (closed.length < 70) {
    return { valid: false, reason: "DATA LOW" };
  }

  const structurePeriod = 20;
  let lastHigh = NaN;
  let lastLow = NaN;
  let highBreakPending = false;
  let lowBreakPending = false;
  let trendDirection = 0;
  let freshEvent = null;

  const closes = closed.map(x => x.close);

  for (let i = 0; i < closed.length; i++) {
    const pivotIndex = i - structurePeriod;

    if (pivotIndex >= 0) {
      const ph = pivotHighAt(closed, pivotIndex, structurePeriod, structurePeriod);
      const pl = pivotLowAt(closed, pivotIndex, structurePeriod, structurePeriod);

      if (ph !== null) {
        lastHigh = ph;
        highBreakPending = true;
      }

      if (pl !== null) {
        lastLow = pl;
        lowBreakPending = true;
      }
    }

    let highBroken = false;
    let lowBroken = false;
    const candle = closed[i];

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

    if (highBroken) trendDirection = 1;
    else if (lowBroken) trendDirection = -1;

    const choch =
      (previousTrend === -1 && trendDirection === 1) ||
      (previousTrend === 1 && trendDirection === -1);

    if (highBroken) {
      freshEvent = {
        index: i,
        direction: "LONG",
        type: choch ? "CHoCH BULLISH" : "BOS BULLISH",
        structure: lastHigh,
        candleTime: candle.time
      };
    }

    if (lowBroken) {
      freshEvent = {
        index: i,
        direction: "SHORT",
        type: choch ? "CHoCH BEARISH" : "BOS BEARISH",
        structure: lastLow,
        candleTime: candle.time
      };
    }
  }

  if (!freshEvent || freshEvent.index !== closed.length - 1) {
    return {
      valid: false,
      reason: "NO FRESH BOS/CHoCH",
      structureHigh: lastHigh,
      structureLow: lastLow
    };
  }

  const last = closed[closed.length - 1];
  const e9 = ema(closes.slice(-120), 9);
  const e20 = ema(closes.slice(-140), 20);
  const atr14 = atr(closed, 14);
  const atrValues = atrSeries(closed, 14);
  const atrSma20 = sma(atrValues, 20);
  const volatilityOk =
    Number.isFinite(atrSma20) && atr14 > atrSma20;

  const emaLong = e9 > e20 && last.close > e9;
  const emaShort = e9 < e20 && last.close < e9;

  let score = 0;
  score += 2; // BOS/CHoCH valid.
  if (freshEvent.type.startsWith("CHoCH")) score += 1;
  if (
    (freshEvent.direction === "LONG" && emaLong) ||
    (freshEvent.direction === "SHORT" && emaShort)
  ) score += 1.5;
  if (volatilityOk) score += 1;
  if (
    (freshEvent.direction === "LONG" && e9 > e20) ||
    (freshEvent.direction === "SHORT" && e9 < e20)
  ) score += 1.5;
  if (
    (freshEvent.direction === "LONG" && last.close > e20) ||
    (freshEvent.direction === "SHORT" && last.close < e20)
  ) score += 1;

  const grade = getGrade(score);
  const emaOk =
    freshEvent.direction === "LONG" ? emaLong : emaShort;

  if (!emaOk || !volatilityOk || !["A", "A+"].includes(grade)) {
    return {
      valid: false,
      reason: "FILTER FAILED",
      grade,
      score,
      emaOk,
      volatilityOk
    };
  }

  const targetRange = atr14 * 2;
  const entry = freshEvent.structure;

  let signal;
  let tp1;
  let tp2;
  let tp3;
  let sl;

  if (freshEvent.direction === "LONG") {
    signal = "OPEN LONG";
    tp1 = entry + targetRange * 0.8;
    tp2 = entry + targetRange * 1.6;
    tp3 = entry + targetRange * 2.8;
    sl = entry - targetRange * 1.2;
  } else {
    signal = "OPEN SHORT";
    tp1 = entry - targetRange * 0.8;
    tp2 = entry - targetRange * 1.6;
    tp3 = entry - targetRange * 2.8;
    sl = entry + targetRange * 1.2;
  }

  const stateKey = pair + "|" + tf;
  const previousDirection = state.lastDirectionByPairTf[stateKey];
  let finalSignal = signal;

  if (
    previousDirection &&
    previousDirection !== freshEvent.direction
  ) {
    finalSignal =
      freshEvent.direction === "LONG"
        ? "REVERSE LONG"
        : "REVERSE SHORT";
  }

  const eventKey = [
    pair,
    tfLabel(tf),
    finalSignal,
    freshEvent.candleTime,
    fmtPrice(entry)
  ].join("|");

  return {
    valid: true,
    key: eventKey,
    pair,
    tf: tfLabel(tf),
    signal: finalSignal,
    status: finalSignal,
    engine: "SMC SERVER WORKER",
    grade,
    score,
    entry,
    tp1,
    tp2,
    tp3,
    sl,
    atr: atr14,
    mainSignal: freshEvent.type,
    candleTime: freshEvent.candleTime,
    direction: freshEvent.direction,
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

  const apiKey = API_KEYS[keyIndex++ % API_KEYS.length];
  const url = new URL("https://api.twelvedata.com/time_series");

  url.searchParams.set("symbol", pair);
  url.searchParams.set("interval", intervalFromTf(tf));
  url.searchParams.set("outputsize", String(OUTPUT_SIZE));
  url.searchParams.set("format", "JSON");
  url.searchParams.set("apikey", apiKey);

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
      sl: fmtPrice(signal.sl)
    })
  });
}

async function processPairTf(pair, tf) {
  const candles = await fetchCandles(pair, tf);
  const signal = analyzeSmc(pair, tf, candles);

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
    fmtPrice(signal.entry)
  );
}

async function runAutoScanner() {
  if (running) {
    console.log("[WORKER] Scan sebelumnya masih berjalan, skip.");
    return;
  }

  running = true;
  const started = Date.now();

  console.log(
    "\n[WORKER] Scan mulai",
    new Date().toISOString(),
    "pairs=" + PAIRS.join(","),
    "tfs=" + TFS.join(",")
  );

  try {
    for (const tf of TFS) {
      for (const pair of PAIRS) {
        try {
          await processPairTf(pair, tf);
        } catch (error) {
          console.error(
            "[SCAN ERROR]",
            pair,
            tfLabel(tf),
            error.message
          );
        }

        // Mengurangi risiko rate limit Twelve Data.
        await sleep(1500);
      }
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
  console.log("DEWA SMC SERVER SCANNER WORKER");
  console.log("APP:", APP_BASE_URL);
  console.log("PAIR:", PAIRS.join(", "));
  console.log("TF:", TFS.join(", "));
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
  await runAutoScanner();

  setInterval(() => {
    runAutoScanner().catch(error => {
      console.error("[WORKER FATAL LOOP]", error);
    });
  }, SCAN_SECONDS * 1000);
}

main().catch(error => {
  console.error("[WORKER START ERROR]", error);
  process.exit(1);
});
