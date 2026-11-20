import "dotenv/config";
import express from "express";
import crypto from "crypto";
import cors from "cors";

const app = express();
app.use(
  cors({
    origin: process.env.ALLOWED_ORIGIN || "*",
  })
);
app.use(express.json());

const SPEC_ID = "DESK-EVM-BINANCE-001";
const PORT = Number(process.env.PORT || 8787);
const API_KEY = (process.env.BINANCE_API_KEY || "").trim();
const API_SECRET = (process.env.BINANCE_API_SECRET || "").trim();
const IS_TESTNET = process.env.BINANCE_TESTNET !== "false";

const BASE_URL = IS_TESTNET
  ? "https://testnet.binance.vision"
  : "https://api.binance.com";

const MAX_ORDER_USDT = Number(process.env.MAX_ORDER_USDT || 10.0);
const QUOTE_TTL_MS = Number(process.env.QUOTE_TTL_MS || 15000);
const ALLOWED_SYMBOLS = new Set(
  (process.env.ALLOWED_SYMBOLS || "BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
);

// منع تكرار تنفيذ نفس الأمر عند إعادة المحاولة (Idempotency)
const processedOrderIds = new Map();

function signQuery(queryString) {
  return crypto
    .createHmac("sha256", API_SECRET)
    .update(queryString)
    .digest("hex");
}

async function binanceSignedRequest(method, path, params = {}) {
  if (!API_KEY || !API_SECRET) {
    throw new Error("BINANCE_API_KEY أو BINANCE_API_SECRET غير مضبوطة في متغيرات البيئة");
  }

  const timestamp = Date.now();
  const searchParams = new URLSearchParams({
    ...params,
    recvWindow: "5000",
    timestamp: String(timestamp),
  });

  const queryString = searchParams.toString();
  const signature = signQuery(queryString);
  const url = `${BASE_URL}${path}?${queryString}&signature=${signature}`;

  const response = await fetch(url, {
    method,
    headers: {
      "X-MBX-APIKEY": API_KEY,
      "Content-Type": "application/json",
    },
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.msg || `Binance API Error (${response.status})`);
  }
  return data;
}

// فحص الاتصال وقراءة رصيد USDT وحالة التداول
app.get("/api/health", async (req, res) => {
  try {
    const account = await binanceSignedRequest("GET", "/api/v3/account");

    if (account.canWithdraw === true) {
      return res.status(403).json({
        ok: false,
        specId: SPEC_ID,
        error: "تحذير أمني: صلاحية السحب (Enable Withdrawals) مفعّلة! يجب تعطيلها من Binance.",
      });
    }

    const usdtObj = (account.balances || []).find((b) => b.asset === "USDT");
    const usdtFree = usdtObj ? Number(usdtObj.free) : 0;
    const usdtLocked = usdtObj ? Number(usdtObj.locked) : 0;

    res.json({
      ok: true,
      specId: SPEC_ID,
      mode: IS_TESTNET ? "TESTNET" : "LIVE",
      endpoint: BASE_URL,
      canTrade: Boolean(account.canTrade),
      canWithdraw: Boolean(account.canWithdraw),
      usdtFree,
      usdtLocked,
      maxOrderUsdt: MAX_ORDER_USDT,
      allowedSymbols: Array.from(ALLOWED_SYMBOLS),
      serverTime: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      specId: SPEC_ID,
      error: err.message,
    });
  }
});

// جلب أفضل سعر شراء/بيع حي لزوج مسموح
app.get("/api/ticker/:symbol", async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    if (!ALLOWED_SYMBOLS.has(symbol)) {
      return res.status(400).json({
        ok: false,
        error: `الزوج ${symbol} غير مدرج في القائمة المسموحة`,
      });
    }

    const response = await fetch(`${BASE_URL}/api/v3/ticker/bookTicker?symbol=${symbol}`);
    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({
        ok: false,
        error: data.msg || "فشل جلب السعر",
      });
    }

    res.json({
      ok: true,
      symbol: data.symbol,
      bidPrice: Number(data.bidPrice),
      askPrice: Number(data.askPrice),
      timestamp: Date.now(),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// تنفيذ أمر تداول بعد التحقق من حوكمة الوكلاء السبعة وحدود المخاطر
app.post("/api/order", async (req, res) => {
  try {
    const {
      symbol,
      side,
      quoteOrderQty,
      clientOrderId,
      quoteTimestamp,
      governance,
    } = req.body || {};

    if (!clientOrderId || typeof clientOrderId !== "string") {
      return res.status(400).json({
        ok: false,
        status: "BLOCKED",
        error: "clientOrderId مطلوب لمنع تكرار الأمر",
      });
    }

    if (processedOrderIds.has(clientOrderId)) {
      return res.json({
        ok: true,
        duplicate: true,
        result: processedOrderIds.get(clientOrderId),
      });
    }

    if (
      !governance ||
      governance.reviewerDecision !== "APPROVE" ||
      governance.riskOfficerVeto === true ||
      governance.passedAgents !== 7
    ) {
      return res.status(403).json({
        ok: false,
        status: "VETOED",
        error: "مرفوض: يتطلب اجتياز الوكلاء السبعة وموافقة Independent Reviewer الصريحة.",
      });
    }

    if (!quoteTimestamp || Date.now() - Number(quoteTimestamp) > QUOTE_TTL_MS) {
      return res.status(409).json({
        ok: false,
        status: "BLOCKED",
        error: "انتهت صلاحية عرض السعر (Stale Quote TTL).",
      });
    }

    const cleanSymbol = String(symbol || "").toUpperCase();
    const cleanSide = String(side || "").toUpperCase();
    const amountUsdt = Number(quoteOrderQty);

    if (!ALLOWED_SYMBOLS.has(cleanSymbol)) {
      return res.status(400).json({
        ok: false,
        status: "BLOCKED",
        error: `الزوج ${cleanSymbol} غير مسموح`,
      });
    }

    if (!["BUY", "SELL"].includes(cleanSide)) {
      return res.status(400).json({
        ok: false,
        status: "BLOCKED",
        error: "اتجاه الأمر يجب أن يكون BUY أو SELL",
      });
    }

    if (!Number.isFinite(amountUsdt) || amountUsdt <= 0 || amountUsdt > MAX_ORDER_USDT) {
      return res.status(400).json({
        ok: false,
        status: "VETOED",
        error: `قيمة الصفقة (${amountUsdt} USDT) تتجاوز الحد الأقصى (${MAX_ORDER_USDT} USDT).`,
      });
    }

    const orderResult = await binanceSignedRequest("POST", "/api/v3/order", {
      symbol: cleanSymbol,
      side: cleanSide,
      type: "MARKET",
      quoteOrderQty: amountUsdt.toFixed(2),
      newClientOrderId: clientOrderId,
    });

    processedOrderIds.set(clientOrderId, orderResult);

    res.json({
      ok: true,
      specId: SPEC_ID,
      mode: IS_TESTNET ? "TESTNET" : "LIVE",
      order: orderResult,
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      status: "ERROR",
      error: err.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`[${SPEC_ID}] Binance Bridge running on port ${PORT} (${IS_TESTNET ? "TESTNET" : "LIVE"})`);
});
