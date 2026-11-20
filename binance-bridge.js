const http = require("http");
const crypto = require("crypto");

const PORT = process.env.PORT || 10000;
const API_KEY = (process.env.BINANCE_API_KEY || "").trim();
const API_SECRET = (process.env.BINANCE_API_SECRET || "").trim();
const USE_TESTNET = String(process.env.BINANCE_TESTNET || "false").toLowerCase() === "true";
const BASE_URL = USE_TESTNET ? "https://testnet.binance.vision" : "https://api.binance.com";

const CAP_LIMIT = Number(process.env.CAPITAL_LIMIT_USDT || 10);
const MAX_RISK = Number(process.env.MAX_RISK_PER_TRADE || 0.02);

let botState = {
  running: false,
  mode: process.env.TRADING_MODE || "live",
  symbol: "BTCUSDT",
  capitalLimit: CAP_LIMIT,
  maxRisk: MAX_RISK,
  usdtFree: null,
  usdtLocked: null,
  startedAt: null,
  lastCycleAt: null,
  tradesCount: 0,
  lastAction: "بانتظار أمر البدء",
  lastError: null,
  audits: []
};

let loopTimer = null;

function signQuery(params) {
  const query = new URLSearchParams(params).toString();
  const signature = crypto.createHmac("sha256", API_SECRET).update(query).digest("hex");
  return `${query}&signature=${signature}`;
}

async function binancePublic(path) {
  const res = await fetch(`${BASE_URL}${path}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.msg || `HTTP ${res.status}`);
  return data;
}

async function binanceSigned(method, path, params = {}) {
  if (!API_KEY || !API_SECRET) {
    throw new Error("متغيرات BINANCE_API_KEY أو BINANCE_API_SECRET غير مضبوطة في Render");
  }
  const signed = signQuery({ ...params, timestamp: Date.now(), recvWindow: 5000 });
  const res = await fetch(`${BASE_URL}${path}?${signed}`, {
    method,
    headers: { "X-MBX-APIKEY": API_KEY }
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Binance (${data.code || res.status}): ${data.msg || "خطأ غير معروف"}`);
  return data;
}

async function fetchUsdtBalance() {
  const account = await binanceSigned("GET", "/api/v3/account");
  const usdtObj = (account.balances || []).find(b => b.asset === "USDT");
  const free = usdtObj ? parseFloat(usdtObj.free) : 0;
  const locked = usdtObj ? parseFloat(usdtObj.locked) : 0;
  botState.usdtFree = Number(free.toFixed(4));
  botState.usdtLocked = Number(locked.toFixed(4));
  return { free, locked };
}

async function runAgentCycle() {
  try {
    botState.lastCycleAt = new Date().toISOString();
    const symbol = botState.symbol || "BTCUSDT";

    // 1. Flow Scout & Liquidity Analyst: جلب السعر وبيانات السيولة
    const ticker = await binancePublic(`/api/v3/ticker/24hr?symbol=${symbol}`);
    const price = parseFloat(ticker.lastPrice);
    const changePct = parseFloat(ticker.priceChangePercent);
    const quoteVol = parseFloat(ticker.quoteVolume);

    // 2. Wallet Analyst: فحص رصيد USDT الفعلي في بايننس
    const { free: usdtFree } = await fetchUsdtBalance();

    // 3. Risk Officer: فرض حد رأس المال 10 USDT ونسبة المخاطرة 0.02
    const allowedCap = Math.min(usdtFree, botState.capitalLimit);
    const orderNotional = Math.max(5.5, Math.min(allowedCap, botState.capitalLimit));

    let decision = "HOLD — مراقبة السوق دون فتح صفقة";
    let executionDetail = `السعر: ${price} | التغير 24س: ${changePct.toFixed(2)}% | الرصيد الفعلي: ${usdtFree.toFixed(2)} USDT`;

    // 4. Strategy Lead & Execution Engineer: شرط الدخول
    if (allowedCap >= 5.5 && quoteVol > 10000000 && changePct > 0.35 && changePct < 6.0) {
      if (botState.mode === "live" || botState.mode === "testnet") {
        const order = await binanceSigned("POST", "/api/v3/order", {
          symbol,
          side: "BUY",
          type: "MARKET",
          quoteOrderQty: orderNotional.toFixed(2)
        });
        botState.tradesCount += 1;
        decision = `BUY EXECUTED (${orderNotional.toFixed(2)} USDT)`;
        executionDetail = `OrderID: ${order.orderId} | الحالة: ${order.status}`;
        await fetchUsdtBalance();
      } else {
        decision = `PAPER BUY (${orderNotional.toFixed(2)} USDT)`;
      }
    }

    botState.lastAction = `${decision} — ${executionDetail}`;
    botState.lastError = null;
    botState.audits.unshift({
      time: new Date().toLocaleTimeString("ar-EG"),
      symbol,
      price,
      usdtFree: Number(usdtFree.toFixed(2)),
      decision,
      detail: executionDetail
    });
    if (botState.audits.length > 25) botState.audits.pop();
  } catch (err) {
    botState.lastError = err.message;
    botState.lastAction = `خطأ أثناء الدورة: ${err.message}`;
  }
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise(resolve => {
    let raw = "";
    req.on("data", chunk => (raw += chunk));
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { resolve({}); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return sendJson(res, 200, { ok: true });

  const url = req.url.split("?")[0];

  if (url === "/" || url === "/health") {
    if (API_KEY && API_SECRET) {
      try {
        await fetchUsdtBalance();
        botState.lastError = null;
      } catch (err) {
        botState.lastError = err.message;
      }
    }
    return sendJson(res, 200, {
      ok: true,
      service: "grok-bot-binance-bridge",
      specId: "DESK-EVM-BINANCE-001",
      keysConfigured: Boolean(API_KEY && API_SECRET),
      testnet: USE_TESTNET,
      state: botState
    });
  }

  if (url === "/api/balance" && req.method === "GET") {
    try {
      const bal = await fetchUsdtBalance();
      botState.lastError = null;
      return sendJson(res, 200, { ok: true, usdtFree: botState.usdtFree, usdtLocked: botState.usdtLocked, bal });
    } catch (err) {
      botState.lastError = err.message;
      return sendJson(res, 500, { ok: false, error: err.message });
    }
  }

  if (url === "/api/status" && req.method === "GET") {
    return sendJson(res, 200, { ok: true, state: botState });
  }

  if (url === "/api/trade/start" && req.method === "POST") {
    const body = await readBody(req);
    if (body.symbol) botState.symbol = String(body.symbol).toUpperCase().trim();
    if (body.capitalLimit) botState.capitalLimit = Math.min(10, Number(body.capitalLimit) || 10);
    if (body.maxRisk) botState.maxRisk = Number(body.maxRisk) || 0.02;
    if (body.mode) botState.mode = String(body.mode);

    botState.running = true;
    botState.startedAt = new Date().toISOString();
    botState.lastError = null;

    if (loopTimer) clearInterval(loopTimer);
    await runAgentCycle();
    loopTimer = setInterval(runAgentCycle, 30000);

    return sendJson(res, 200, { ok: true, message: "تم بدء التداول الآلي", state: botState });
  }

  if (url === "/api/trade/stop" && req.method === "POST") {
    botState.running = false;
    if (loopTimer) {
      clearInterval(loopTimer);
      loopTimer = null;
    }
    botState.lastAction = "تم إيقاف التداول الآلي يدوياً";
    return sendJson(res, 200, { ok: true, message: "تم إيقاف التداول", state: botState });
  }

  return sendJson(res, 404, { ok: false, error: "Route not found" });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Binance Bridge running on port ${PORT}`);
});
