const http = require("http");
const crypto = require("crypto");

const PORT = process.env.PORT || 10000;
const API_KEY = (process.env.BINANCE_API_KEY || "").trim();
const API_SECRET = (process.env.BINANCE_API_SECRET || "").trim();
const USE_TESTNET = String(process.env.BINANCE_TESTNET || "false").toLowerCase() === "true";
const BASE_URL = USE_TESTNET ? "https://testnet.binance.vision" : "https://api.binance.com";

const DEFAULT_RISK = Number(process.env.MAX_RISK_PER_TRADE || 0.02);
const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
const ALLOWED_CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || "6406388705").trim();

let botState = {
  running: false,
  mode: process.env.TRADING_MODE || "live",
  symbol: "BTCUSDT",
  useRealBalanceOnly: true,
  maxRisk: DEFAULT_RISK,
  usdtFree: null,
  usdtLocked: null,
  startedAt: null,
  lastCycleAt: null,
  tradesCount: 0,
  lastAction: "بانتظار أمر البدء (يعتمد على الرصيد الفعلي)",
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
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "Markdown"
      })
    });
  } catch (_) {}
}

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
    throw new Error("متغيرات BINANCE_API_KEY أو BINANCE_API_SECRET غير مضبوطة");
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

    // 3. Risk Officer: الاعتماد على الرصيد الفعلي فقط دون سقف ثابت
    const riskFraction = Math.max(0.001, Math.min(1, Number(botState.maxRisk) || DEFAULT_RISK));
    const orderNotional = Number((usdtFree * riskFraction).toFixed(2));

    let decision = "HOLD — مراقبة السوق دون فتح صفقة";
    let executionDetail = `السعر: ${price} | التغير 24س: ${changePct.toFixed(2)}% | الرصيد الفعلي: ${usdtFree.toFixed(2)} USDT | قيمة الصفقة المحسوبة: ${orderNotional.toFixed(2)} USDT`;
    let orderExecuted = false;

    // 4. Strategy Lead & Execution Engineer: شرط الدخول الفعلي
    if (usdtFree >= 5.5 && orderNotional >= 5.5 && quoteVol > 10000000 && changePct > 0.35 && changePct < 6.0) {
      if (botState.mode === "live" || botState.mode === "testnet") {
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
      keysConfigured: Boolean(API_KEY && API_SECRET),
      telegramConfigured: Boolean(TELEGRAM_BOT_TOKEN),
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
  console.log(`Binance Bridge running on port ${PORT}`);
  if (TELEGRAM_BOT_TOKEN) {
    setInterval(pollTelegramUpdates, 4000);
  }
});
