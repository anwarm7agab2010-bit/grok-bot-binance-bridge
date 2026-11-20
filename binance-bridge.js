const http = require("http");
const crypto = require("crypto");

const PORT = process.env.PORT || 10000;
const API_KEY = String(process.env.BINANCE_API_KEY || "").replace(/[^A-Za-z0-9]/g, "");
const API_SECRET = String(process.env.BINANCE_API_SECRET || "").replace(/[^A-Za-z0-9]/g, "");
const BASE_URL = "https://api.binance.com";

const DEFAULT_RISK = Number(process.env.MAX_RISK_PER_TRADE || 0.02);
const TELEGRAM_BOT_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || "").replace(/[\r\n\s]+/g, "");
const ALLOWED_CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || "6406388705").trim();

let timeOffset = 0;
let lastTimeSyncAt = 0;

let botState = {
  running: false,
  mode: process.env.TRADING_MODE || "live",
  symbol: "BTCUSDT",
  useRealBalanceOnly: true,
  maxRisk: DEFAULT_RISK,
  usdtFree: null,
  usdtLocked: null,
  timeOffsetMs: 0,
  startedAt: null,
  lastCycleAt: null,
  tradesCount: 0,
  lastAction: "جاهز — يعتمد على الرصيد الفعلي فقط",
  lastError: null,
  audits: []
};

let loopTimer = null;
let telegramOffset = 0;

async function sendTelegramMessage(text, chatId = ALLOWED_CHAT_ID) {
  if (!TELEGRAM_BOT_TOKEN || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" })
    });
  } catch (_) {}
}

async function syncBinanceTime(force = false) {
  const now = Date.now();
  if (!force && lastTimeSyncAt && now - lastTimeSyncAt < 45000) {
    return timeOffset;
  }
  const t0 = Date.now();
  const res = await fetch(`${BASE_URL}/api/v3/time`);
  const data = await res.json();
  const t1 = Date.now();
  if (!res.ok || typeof data.serverTime !== "number") {
    throw new Error(data.msg || "فشل جلب وقت خادم Binance");
  }
  const localMid = Math.floor((t0 + t1) / 2);
  timeOffset = data.serverTime - localMid;
  lastTimeSyncAt = t1;
  botState.timeOffsetMs = timeOffset;
  return timeOffset;
}

function buildSignedQuery(params) {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "");
  const queryString = entries
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
  const signature = crypto.createHmac("sha256", API_SECRET).update(queryString).digest("hex");
  return `${queryString}&signature=${signature}`;
}

async function binancePublic(path) {
  const res = await fetch(`${BASE_URL}${path}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.msg || `HTTP ${res.status}`);
  return data;
}

async function binanceSigned(method, path, params = {}, retried = false) {
  if (API_KEY.length !== 64 || API_SECRET.length !== 64) {
    throw new Error(`طول المفاتيح غير صحيح (KEY:${API_KEY.length}, SECRET:${API_SECRET.length})`);
  }
  await syncBinanceTime(retried);
  const timestamp = Date.now() + timeOffset;
  const fullQuery = buildSignedQuery({
    ...params,
    recvWindow: 15000,
    timestamp
  });

  const url = `${BASE_URL}${path}?${fullQuery}`;
  const res = await fetch(url, {
    method,
    headers: {
      "X-MBX-APIKEY": API_KEY
    }
  });
  const data = await res.json();

  if (!res.ok) {
    if (!retried && (data.code === -1021 || data.code === -1022)) {
      return binanceSigned(method, path, params, true);
    }
    throw new Error(`Binance (${data.code || res.status}): ${data.msg || "خطأ غير معروف"}`);
  }
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

    const ticker = await binancePublic(`/api/v3/ticker/24hr?symbol=${symbol}`);
    const price = parseFloat(ticker.lastPrice);
    const changePct = parseFloat(ticker.priceChangePercent);
    const quoteVol = parseFloat(ticker.quoteVolume);

    const { free: usdtFree } = await fetchUsdtBalance();
    const riskFraction = Math.max(0.001, Math.min(1, Number(botState.maxRisk) || DEFAULT_RISK));
    const orderNotional = Number((usdtFree * riskFraction).toFixed(2));

    let decision = "HOLD — مراقبة السوق دون فتح صفقة";
    let executionDetail = `السعر: ${price} | التغير 24س: ${changePct.toFixed(2)}% | الرصيد الفعلي: ${usdtFree.toFixed(2)} USDT | قيمة الصفقة المحسوبة: ${orderNotional.toFixed(2)} USDT`;
    let orderExecuted = false;

    if (usdtFree >= 5.5 && orderNotional >= 5.5 && quoteVol > 10000000 && changePct > 0.35 && changePct < 6.0) {
      if (botState.mode === "live") {
        const order = await binanceSigned("POST", "/api/v3/order", {
          symbol,
          side: "BUY",
          type: "MARKET",
          quoteOrderQty: orderNotional.toFixed(2)
        });
        botState.tradesCount += 1;
        orderExecuted = true;
        decision = `BUY EXECUTED (${orderNotional.toFixed(2)} USDT من الرصيد الفعلي)`;
        executionDetail = `OrderID: ${order.orderId} | الرصيد قبل الأمر: ${usdtFree.toFixed(2)} USDT`;
        await fetchUsdtBalance();
      } else {
        decision = `PAPER BUY (${orderNotional.toFixed(2)} USDT من الرصيد الفعلي)`;
        orderExecuted = true;
      }
    }

    botState.lastAction = `${decision} — ${executionDetail}`;
    botState.lastError = null;
    botState.audits.unshift({
      time: new Date().toLocaleTimeString("ar-EG"),
      symbol,
      price,
      usdtFree: Number(usdtFree.toFixed(2)),
      orderNotional,
      decision,
      detail: executionDetail
    });
    if (botState.audits.length > 25) botState.audits.pop();

    if (orderExecuted) {
      await sendTelegramMessage(
        `✅ *تنفيذ صفقة — Grok Bot Terminal*\n• الزوج: \`${symbol}\`\n• القرار: *${decision}*\n• الرصيد الفعلي: *${Number(botState.usdtFree ?? usdtFree).toFixed(2)} USDT*\n• التفاصيل: ${executionDetail}`
      );
    }
  } catch (err) {
    const prevErr = botState.lastError;
    botState.lastError = err.message;
    botState.lastAction = `خطأ أثناء الدورة: ${err.message}`;
    if (prevErr !== err.message) {
      await sendTelegramMessage(`⚠️ *تنبيه من الجسر*\n• الزوج: \`${botState.symbol}\`\n• الخطأ: \`${err.message}\``);
    }
  }
}

async function handleTelegramCommand(msg) {
  const chatId = String(msg.chat?.id || "");
  const text = String(msg.text || "").trim();
  if (!text.startsWith("/")) return;

  if (ALLOWED_CHAT_ID && chatId !== ALLOWED_CHAT_ID) {
    await sendTelegramMessage("⛔ غير مصرح لك باستخدام هذا البوت.", chatId);
    return;
  }

  const parts = text.split(/\s+/);
  const cmd = parts[0].split("@")[0].toLowerCase();
  const arg = (parts[1] || "").toUpperCase().trim();

  if (cmd === "/balance") {
    try {
      const { free, locked } = await fetchUsdtBalance();
      const notional = Number((free * (Number(botState.maxRisk) || DEFAULT_RISK)).toFixed(2));
      await sendTelegramMessage(
        `💰 *رصيد Binance الفعلي*\n• المتاح: *${free.toFixed(2)} USDT*\n• المحجوز: *${locked.toFixed(2)} USDT*\n• حجم الصفقة المحسوب (${botState.maxRisk}): *${notional.toFixed(2)} USDT*`,
        chatId
      );
    } catch (err) {
      await sendTelegramMessage(`❌ تعذر جلب الرصيد: \`${err.message}\``, chatId);
    }
    return;
  }

  if (cmd === "/status") {
    const runText = botState.running ? `يعمل (${botState.symbol})` : "متوقف";
    const errLine = botState.lastError ? `\n• ⚠️ تنبيه: \`${botState.lastError}\`` : "";
    await sendTelegramMessage(
      `📡 *حالة Grok Bot Terminal*\n• حالة البوت: *${runText}*\n• الوضع: *${botState.mode}*\n• الرصيد الفعلي: *${botState.usdtFree !== null ? botState.usdtFree.toFixed(2) + " USDT" : "-- USDT"}*\n• المخاطرة: *${botState.maxRisk}*\n• آخر إجراء: ${botState.lastAction}${errLine}`,
      chatId
    );
    return;
  }

  if (cmd === "/start") {
    if (arg) botState.symbol = arg;
    botState.useRealBalanceOnly = true;
    botState.running = true;
    botState.startedAt = new Date().toISOString();
    botState.lastError = null;
    if (loopTimer) clearInterval(loopTimer);
    await runAgentCycle();
    loopTimer = setInterval(runAgentCycle, 30000);
    await sendTelegramMessage(
      `▶️ تم بدء التداول الآلي على *${botState.symbol}* بالرصيد الفعلي فقط (مخاطرة *${botState.maxRisk}*).`,
      chatId
    );
    return;
  }

  if (cmd === "/stop") {
    botState.running = false;
    if (loopTimer) {
      clearInterval(loopTimer);
      loopTimer = null;
    }
    botState.lastAction = "تم إيقاف التداول الآلي عبر تليجرام";
    await sendTelegramMessage("⏹️ تم إيقاف التداول الآلي.", chatId);
  }
}

async function pollTelegramUpdates() {
  if (!TELEGRAM_BOT_TOKEN) return;
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${telegramOffset}&timeout=10`
    );
    const data = await res.json();
    if (data.ok && Array.isArray(data.result)) {
      for (const item of data.result) {
        telegramOffset = item.update_id + 1;
        if (item.message) {
          await handleTelegramCommand(item.message);
        }
      }
    }
  } catch (_) {}
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
      keysConfigured: Boolean(API_KEY.length === 64 && API_SECRET.length === 64),
      secretHashPrefix: crypto.createHash("sha256").update(API_SECRET).digest("hex").slice(0, 8),
      telegramConfigured: Boolean(TELEGRAM_BOT_TOKEN),
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
    if (body.maxRisk) botState.maxRisk = Number(body.maxRisk) || DEFAULT_RISK;
    if (body.mode) botState.mode = String(body.mode);
    botState.useRealBalanceOnly = true;

    botState.running = true;
    botState.startedAt = new Date().toISOString();
    botState.lastError = null;

    if (loopTimer) clearInterval(loopTimer);
    await runAgentCycle();
    loopTimer = setInterval(runAgentCycle, 30000);

    await sendTelegramMessage(
      `▶️ تم بدء التداول الآلي من الواجهة على *${botState.symbol}* بالرصيد الفعلي فقط (مخاطرة *${botState.maxRisk}*).`
    );

    return sendJson(res, 200, { ok: true, message: "تم بدء التداول الآلي بالرصيد الفعلي", state: botState });
  }

  if (url === "/api/trade/stop" && req.method === "POST") {
    botState.running = false;
    if (loopTimer) {
      clearInterval(loopTimer);
      loopTimer = null;
    }
    botState.lastAction = "تم إيقاف التداول الآلي يدوياً";
    await sendTelegramMessage("⏹️ تم إيقاف التداول الآلي من الواجهة.");
    return sendJson(res, 200, { ok: true, message: "تم إيقاف التداول", state: botState });
  }

  return sendJson(res, 404, { ok: false, error: "Route not found" });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Binance Bridge v2 running on port ${PORT}`);
  syncBinanceTime(true).catch(() => {});
  if (TELEGRAM_BOT_TOKEN) {
    setInterval(pollTelegramUpdates, 4000);
  }
});
