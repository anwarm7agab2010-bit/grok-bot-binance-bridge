const http = require("http");
const crypto = require("crypto");

const PORT = process.env.PORT || 10000;
const RAW_KEY = String(process.env.BINANCE_API_KEY || "");
const RAW_SECRET = String(process.env.BINANCE_API_SECRET || "");
const API_KEY = RAW_KEY.replace(/[^A-Za-z0-9]/g, "");
const API_SECRET = RAW_SECRET.replace(/[^A-Za-z0-9]/g, "");
const BASE_URL = "https://api.binance.com";

const DEFAULT_RISK = Number(process.env.MAX_RISK_PER_TRADE || 0.02);
const TELEGRAM_BOT_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || "").replace(/[\r\n\s]+/g, "");
const ALLOWED_CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || "6406388705").trim();

// توكن حماية مسارات /api/* (ضعه في Railway باسم ADMIN_TOKEN)
const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || "").trim();
// أقل مدة بين صفقتين (بالدقائق)، الافتراضي 6 ساعات
const BUY_COOLDOWN_MS = Number(process.env.BUY_COOLDOWN_MIN || 360) * 60000;

let timeOffset = 0;
let lastTimeSyncAt = 0;
let lastBuyAt = 0;

let botState = {
  running: false,
  // الافتراضي الآن paper؛ للتداول الحقيقي ضع TRADING_MODE=live
  mode: process.env.TRADING_MODE || "paper",
  symbol: "BTCUSDT",
  useRealBalanceOnly: true,
  maxRisk: DEFAULT_RISK,
  usdtFree: null,
  usdtLocked: null,
  timeOffsetMs: 0,
