// =================================================================
// OKX Advanced Analytics Bot - v127 (Virtual Trade Monitoring Fix)
// By: Gemini & User
// Description: A complete 1-to-1 port of the original bot's functionality,
// with a critical fix for the virtual trade monitoring cron job.
// Added extensive debugging to the monitoring function.
// =================================================================

const express = require("express");
const { Bot, Keyboard, InlineKeyboard, webhookCallback } = require("grammy");
const fetch = require("node-fetch");
const crypto = require("crypto");
const { Redis } = require("@upstash/redis");

// --- إعدادات البوت ---
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
const AUTHORIZED_USER_ID = parseInt(process.env.AUTHORIZED_USER_ID);
const API_BASE_URL = "https://www.okx.com";

// --- متغيرات الحالة (للتفاعل مع المستخدم) ---
let waitingState = null;

// =================================================================
// SECTION 1: DATABASE (VERCEL KV) AND HELPER FUNCTIONS
// =================================================================

let redis;
function connectDB() {
    if (!redis) {
        if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
            throw new Error("KV_REST_API_URL and KV_REST_API_TOKEN must be set in Vercel environment.");
        }
        redis = new Redis({
            url: process.env.KV_REST_API_URL,
            token: process.env.KV_REST_API_TOKEN,
        });
        console.log("Successfully connected to Vercel KV (Redis).");
    }
    return redis;
}

function getDB() {
    if (!redis) return connectDB();
    return redis;
}

// دوال قاعدة البيانات (محسّنة لـ Redis)
async function getConfig(id, defaultValue = {}) { try { const data = await getDB().get(`config:${id}`); return data ? data : defaultValue; } catch (e) { console.error(`DB Error in getConfig for id: ${id}`, e); return defaultValue; } }
async function saveConfig(id, data) { try { await getDB().set(`config:${id}`, data); } catch (e) { console.error(`DB Error in saveConfig for id: ${id}`, e); } }
async function saveClosedTrade(tradeData) { try { await getDB().lpush("tradeHistory", JSON.stringify(tradeData)); } catch (e) { console.error("Error in saveClosedTrade:", e); } }
async function getHistoricalPerformance(asset) { try { const historyRaw = await getDB().lrange("tradeHistory", 0, -1); const history = historyRaw.map(item => JSON.parse(item)).filter(trade => trade.asset === asset); if (history.length === 0) return { realizedPnl: 0, tradeCount: 0, winningTrades: 0, losingTrades: 0, avgDuration: 0 }; const realizedPnl = history.reduce((sum, trade) => sum + trade.pnl, 0); const winningTrades = history.filter(trade => trade.pnl > 0).length; const losingTrades = history.filter(trade => trade.pnl <= 0).length; const totalDuration = history.reduce((sum, trade) => sum + trade.durationDays, 0); const avgDuration = history.length > 0 ? totalDuration / history.length : 0; return { realizedPnl, tradeCount: history.length, winningTrades, losingTrades, avgDuration }; } catch (e) { console.error(`Error fetching historical performance for ${asset}:`, e); return null; } }
async function saveVirtualTrade(tradeData) { try { const tradeWithId = { ...tradeData, _id: crypto.randomBytes(16).toString("hex") }; await getDB().hset("virtualTrades", { [tradeWithId._id]: JSON.stringify(tradeWithId) }); return tradeWithId; } catch (e) { console.error("Error saving virtual trade:", e); } }
async function getActiveVirtualTrades() { try { const allTrades = await getDB().hgetall("virtualTrades"); return allTrades ? Object.values(allTrades).map(item => JSON.parse(item)).filter(trade => trade.status === 'active') : []; } catch (e) { console.error("Error fetching active virtual trades:", e); return []; } }
async function updateVirtualTradeStatus(tradeId, status, finalPrice) { try { const tradeRaw = await getDB().hget("virtualTrades", tradeId); if (tradeRaw) { const trade = JSON.parse(tradeRaw); trade.status = status; trade.closePrice = finalPrice; trade.closedAt = new Date(); await getDB().hset("virtualTrades", { [tradeId]: JSON.stringify(trade) }); } } catch (e) { console.error(`Error updating virtual trade ${tradeId}:`, e); } }

// دوال مساعدة لتحميل وحفظ الإعدادات
const loadCapital = async () => (await getConfig("capital", { value: 0 })).value;
const saveCapital = (amount) => saveConfig("capital", { value: amount });
const loadSettings = async () => await getConfig("settings", { dailySummary: true, autoPostToChannel: false, debugMode: false });
const saveSettings = (settings) => saveConfig("settings", settings);
const loadPositions = async () => await getConfig("positions", {});
const savePositions = (positions) => saveConfig("positions", positions);
const loadHistory = async () => await getConfig("dailyHistory", []);
const saveHistory = (history) => saveConfig("dailyHistory", history);
const loadHourlyHistory = async () => await getConfig("hourlyHistory", []);
const saveHourlyHistory = (history) => saveConfig("hourlyHistory", history);
const loadBalanceState = async () => await getConfig("balanceState", {});
const saveBalanceState = (state) => saveConfig("balanceState", state);
const loadAlerts = async () => await getConfig("priceAlerts", []);
const saveAlerts = (alerts) => saveConfig("priceAlerts", alerts);
const loadAlertSettings = async () => await getConfig("alertSettings", { global: 5, overrides: {} });
const saveAlertSettings = (settings) => saveConfig("alertSettings", settings);
const loadPriceTracker = async () => await getConfig("priceTracker", { totalPortfolioValue: 0, assets: {} });
const savePriceTracker = (tracker) => saveConfig("priceTracker", tracker);

// دوال مساعدة عامة
function formatNumber(num, decimals = 2) { const number = parseFloat(num); if (isNaN(number) || !isFinite(number)) return (0).toFixed(decimals); return number.toFixed(decimals); }
async function sendDebugMessage(message) { const settings = await loadSettings(); if (settings.debugMode) { try { await bot.api.sendMessage(AUTHORIZED_USER_ID, `🐞 *Debug:* ${message}`, { parse_mode: "Markdown" }); } catch (e) { console.error("Failed to send debug message:", e); } } }
function getHeaders(method, path, body = "") { const timestamp = new Date().toISOString(); const prehash = timestamp + method.toUpperCase() + path + (typeof body === 'object' ? JSON.stringify(body) : body); const sign = crypto.createHmac("sha256", process.env.OKX_API_SECRET_KEY).update(prehash).digest("base64"); return { "OK-ACCESS-KEY": process.env.OKX_API_KEY, "OK-ACCESS-SIGN": sign, "OK-ACCESS-TIMESTAMP": timestamp, "OK-ACCESS-PASSPHRASE": process.env.OKX_API_PASSPHRASE, "Content-Type": "application/json", }; }

// =================================================================
// SECTION 2: API AND DATA PROCESSING FUNCTIONS
// =================================================================
async function getMarketPrices() { try { const tickersRes = await fetch(`${API_BASE_URL}/api/v5/market/tickers?instType=SPOT`); const tickersJson = await tickersRes.json(); if (tickersJson.code !== '0') { console.error("Failed to fetch market prices (OKX Error):", tickersJson.msg); return null; } const prices = {}; tickersJson.data.forEach(t => { if (t.instId.endsWith('-USDT')) { const lastPrice = parseFloat(t.last); const openPrice = parseFloat(t.open24h); let change24h = 0; if (openPrice > 0) change24h = (lastPrice - openPrice) / openPrice; prices[t.instId] = { price: lastPrice, open24h: openPrice, change24h, volCcy24h: parseFloat(t.volCcy24h) }; } }); return prices; } catch (error) { console.error("Exception in getMarketPrices:", error.message); return null; } }
async function getPortfolio(prices) { try { const path = "/api/v5/account/balance"; const res = await fetch(`${API_BASE_URL}${path}`, { headers: getHeaders("GET", path) }); const json = await res.json(); if (json.code !== '0' || !json.data || !json.data[0] || !json.data[0].details) { return { error: `فشل جلب المحفظة: ${json.msg || 'بيانات غير متوقعة من المنصة'}` }; } let assets = [], total = 0, usdtValue = 0; json.data[0].details.forEach(asset => { const amount = parseFloat(asset.eq); if (amount > 0) { const instId = `${asset.ccy}-USDT`; const priceData = prices[instId] || { price: (asset.ccy === "USDT" ? 1 : 0), change24h: 0 }; const value = amount * priceData.price; total += value; if (asset.ccy === "USDT") { usdtValue = value; } if (value >= 1) { assets.push({ asset: asset.ccy, price: priceData.price, value, amount, change24h: priceData.change24h }); } } }); assets.sort((a, b) => b.value - a.value); return { assets, total, usdtValue }; } catch (e) { console.error(e); return { error: "خطأ في الاتصال بالمنصة." }; } }
async function getBalanceForComparison() { try { const path = "/api/v5/account/balance"; const res = await fetch(`${API_BASE_URL}${path}`, { headers: getHeaders("GET", path) }); const json = await res.json(); if (json.code !== '0' || !json.data || !json.data[0] || !json.data[0].details) return null; const balanceMap = {}; json.data[0].details.forEach(asset => { balanceMap[asset.ccy] = parseFloat(asset.eq); }); return balanceMap; } catch (error) { console.error("Exception in getBalanceForComparison:", error); return null; } }
async function getInstrumentDetails(instId) { try { const tickerRes = await fetch(`${API_BASE_URL}/api/v5/market/ticker?instId=${instId.toUpperCase()}`); const tickerJson = await tickerRes.json(); if (tickerJson.code !== '0' || !tickerJson.data[0]) return { error: `لم يتم العثور على العملة.` }; const tickerData = tickerJson.data[0]; return { price: parseFloat(tickerData.last), high24h: parseFloat(tickerData.high24h), low24h: parseFloat(tickerData.low24h), vol24h: parseFloat(tickerData.volCcy24h), }; } catch (e) { console.error(e); return { error: "خطأ في الاتصال بالمنصة." }; } }
async function getHistoricalCandles(instId, limit = 100) { try { const res = await fetch(`${API_BASE_URL}/api/v5/market/history-candles?instId=${instId}&bar=1D&limit=${limit}`); const json = await res.json(); if (json.code !== '0' || !json.data || json.data.length === 0) return []; return json.data.map(c => parseFloat(c[4])).reverse(); } catch (e) { console.error(`Exception in getHistoricalCandles for ${instId}:`, e); return []; } }
function calculateSMA(closes, period) { if (closes.length < period) return null; const sum = closes.slice(-period).reduce((acc, val) => acc + val, 0); return sum / period; }
function calculateRSI(closes, period = 14) { if (closes.length < period + 1) return null; let gains = 0, losses = 0; for (let i = 1; i <= period; i++) { const diff = closes[i] - closes[i - 1]; diff > 0 ? gains += diff : losses -= diff; } let avgGain = gains / period, avgLoss = losses / period; for (let i = period + 1; i < closes.length; i++) { const diff = closes[i] - closes[i - 1]; if (diff > 0) { avgGain = (avgGain * (period - 1) + diff) / period; avgLoss = (avgLoss * (period - 1)) / period; } else { avgLoss = (avgLoss * (period - 1) - diff) / period; avgGain = (avgGain * (period - 1)) / period; } } if (avgLoss === 0) return 100; const rs = avgGain / avgLoss; return 100 - (100 / (1 + rs)); }
async function getTechnicalAnalysis(instId) { const closes = await getHistoricalCandles(instId, 51); if (closes.length < 51) return { error: "بيانات الشموع غير كافية." }; return { rsi: calculateRSI(closes), sma20: calculateSMA(closes, 20), sma50: calculateSMA(closes, 50) }; }
function calculatePerformanceStats(history) { if (history.length < 2) return null; const values = history.map(h => h.total); const startValue = values[0]; const endValue = values[values.length - 1]; const pnl = endValue - startValue; const pnlPercent = (startValue > 0) ? (pnl / startValue) * 100 : 0; const maxValue = Math.max(...values); const minValue = Math.min(...values); const avgValue = values.reduce((sum, val) => sum + val, 0) / values.length; return { startValue, endValue, pnl, pnlPercent, maxValue, minValue, avgValue }; }
function createChartUrl(history, periodLabel, pnl) { if (history.length < 2) return null; const chartColor = pnl >= 0 ? 'rgb(75, 192, 75)' : 'rgb(255, 99, 132)'; const chartBgColor = pnl >= 0 ? 'rgba(75, 192, 75, 0.2)' : 'rgba(255, 99, 132, 0.2)'; const labels = history.map(h => h.label); const data = history.map(h => h.total.toFixed(2)); const chartConfig = { type: 'line', data: { labels: labels, datasets: [{ label: 'قيمة المحفظة ($)', data: data, fill: true, backgroundColor: chartBgColor, borderColor: chartColor, tension: 0.1 }] }, options: { title: { display: true, text: `أداء المحفظة - ${periodLabel}` } } }; return `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(chartConfig))}&backgroundColor=white`; }

// =================================================================
// SECTION 3: MESSAGE FORMATTING FUNCTIONS
// =================================================================
function formatPrivateBuy(details) { const { asset, price, amountChange, tradeValue, oldTotalValue, newAssetWeight, newUsdtValue, newCashPercent } = details; const tradeSizePercent = oldTotalValue > 0 ? (tradeValue / oldTotalValue) * 100 : 0; let msg = `*مراقبة الأصول 🔬:*\n**عملية استحواذ جديدة 🟢**\n━━━━━━━━━━━━━━━━━━━━\n`; msg += `🔸 **الأصل المستهدف:** \`${asset}/USDT\`\n`; msg += `🔸 **نوع العملية:** تعزيز مركز / بناء مركز جديد\n`; msg += `━━━━━━━━━━━━━━━━━━━━\n*تحليل الصفقة:*\n`; msg += ` ▪️ **سعر التنفيذ:** \`$${formatNumber(price, 4)}\`\n`; msg += ` ▪️ **الكمية المضافة:** \`${formatNumber(Math.abs(amountChange), 6)}\`\n`; msg += ` ▪️ **التكلفة الإجمالية للصفقة:** \`$${formatNumber(tradeValue)}\`\n`; msg += `━━━━━━━━━━━━━━━━━━━━\n*التأثير على هيكل المحفظة:*\n`; msg += ` ▪️ **حجم الصفقة من إجمالي المحفظة:** \`${formatNumber(tradeSizePercent)}%\`\n`; msg += ` ▪️ **الوزن الجديد للأصل:** \`${formatNumber(newAssetWeight)}%\`\n`; msg += ` ▪️ **السيولة المتبقية (USDT):** \`$${formatNumber(newUsdtValue)}\`\n`; msg += ` ▪️ **مؤشر السيولة الحالي:** \`${formatNumber(newCashPercent)}%\`\n`; msg += `━━━━━━━━━━━━━━━━━━━━\n*بتاريخ:* ${new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo" })}`; return msg; }
function formatPrivateSell(details) { const { asset, price, amountChange, tradeValue, oldTotalValue, newAssetWeight, newUsdtValue, newCashPercent } = details; const tradeSizePercent = oldTotalValue > 0 ? (tradeValue / oldTotalValue) * 100 : 0; let msg = `*مراقبة الأصول 🔬:*\n**مناورة تكتيكية 🟠**\n━━━━━━━━━━━━━━━━━━━━\n`; msg += `🔸 **الأصل المستهدف:** \`${asset}/USDT\`\n`; msg += `🔸 **نوع العملية:** تخفيف المركز / جني أرباح جزئي\n`; msg += `━━━━━━━━━━━━━━━━━━━━\n*تحليل الصفقة:*\n`; msg += ` ▪️ **سعر التنفيذ:** \`$${formatNumber(price, 4)}\`\n`; msg += ` ▪️ **الكمية المخففة:** \`${formatNumber(Math.abs(amountChange), 6)}\`\n`; msg += ` ▪️ **العائد الإجمالي للصفقة:** \`$${formatNumber(tradeValue)}\`\n`; msg += `━━━━━━━━━━━━━━━━━━━━\n*التأثير على هيكل المحفظة:*\n`; msg += ` ▪️ **حجم الصفقة من إجمالي المحفظة:** \`${formatNumber(tradeSizePercent)}%\`\n`; msg += ` ▪️ **الوزن الجديد للأصل:** \`${formatNumber(newAssetWeight)}%\`\n`; msg += ` ▪️ **السيولة الجديدة (USDT):** \`$${formatNumber(newUsdtValue)}\`\n`; msg += ` ▪️ **مؤشر السيولة الحالي:** \`${formatNumber(newCashPercent)}%\`\n`; msg += `━━━━━━━━━━━━━━━━━━━━\n*بتاريخ:* ${new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo" })}`; return msg; }
function formatPrivateCloseReport(details) { const { asset, avgBuyPrice, avgSellPrice, pnl, pnlPercent, durationDays, highestPrice, lowestPrice } = details; const pnlSign = pnl >= 0 ? '+' : ''; const emoji = pnl >= 0 ? '🟢' : '🔴'; let msg = `*ملف المهمة المكتملة 📂:*\n**تم إغلاق مركز ${asset} بنجاح ✅**\n━━━━━━━━━━━━━━━━━━━━\n`; msg += `*النتيجة النهائية للمهمة:*\n`; msg += ` ▪️ **الحالة:** **${pnl >= 0 ? "مربحة" : "خاسرة"}**\n`; msg += ` ▪️ **صافي الربح/الخسارة:** \`${pnlSign}$${formatNumber(pnl)}\` ${emoji}\n`; msg += ` ▪️ **نسبة العائد على الاستثمار (ROI):** \`${pnlSign}${formatNumber(pnlPercent)}%\`\n`; msg += `━━━━━━━━━━━━━━━━━━━━\n*الجدول الزمني والأداء:*\n`; msg += ` ▪️ **مدة الاحتفاظ بالمركز:** \`${formatNumber(durationDays, 1)} يوم\`\n`; msg += ` ▪️ **متوسط سعر الدخول:** \`$${formatNumber(avgBuyPrice, 4)}\`\n`; msg += ` ▪️ **متوسط سعر الخروج:** \`$${formatNumber(avgSellPrice, 4)}\`\n`; msg += ` ▪️ **أعلى قمة سعرية مسجلة:** \`$${formatNumber(highestPrice, 4)}\`\n`; msg += ` ▪️ **أدنى قاع سعري مسجل:** \`$${formatNumber(lowestPrice, 4)}\`\n`; msg += `━━━━━━━━━━━━━━━━━━━━\n*بتاريخ الإغلاق:* ${new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo" })}`; return msg; }
function formatPublicBuy(details) { const { asset, price, oldTotalValue, tradeValue, oldUsdtValue, newCashPercent } = details; const tradeSizePercent = oldTotalValue > 0 ? (tradeValue / oldTotalValue) * 100 : 0; const cashConsumedPercent = (oldUsdtValue > 0) ? (tradeValue / oldUsdtValue) * 100 : 0; let msg = `*💡 توصية جديدة: بناء مركز في ${asset} 🟢*\n━━━━━━━━━━━━━━━━━━━━\n`; msg += `*الأصل:* \`${asset}/USDT\`\n`; msg += `*سعر الدخول الحالي:* \`$${formatNumber(price, 4)}\`\n`; msg += `━━━━━━━━━━━━━━━━━━━━\n*استراتيجية إدارة المحفظة:*\n`; msg += ` ▪️ *حجم الدخول:* تم تخصيص \`${formatNumber(tradeSizePercent)}%\` من المحفظة لهذه الصفقة.\n`; msg += ` ▪️ *استهلاك السيولة:* استهلك هذا الدخول \`${formatNumber(cashConsumedPercent)}%\` من السيولة النقدية المتاحة.\n`; msg += ` ▪️ *السيولة المتبقية:* بعد الصفقة، أصبحت السيولة تشكل \`${formatNumber(newCashPercent)}%\` من المحفظة.\n`; msg += `━━━━━━━━━━━━━━━━━━━━\n*ملاحظات:*\nنرى في هذه المستويات فرصة واعدة. المراقبة مستمرة، وسنوافيكم بتحديثات إدارة الصفقة.\n`; msg += `#توصية #${asset}`; return msg; }
function formatPublicSell(details) { const { asset, price, amountChange, position } = details; const totalPositionAmountBeforeSale = position.totalAmountBought - (position.totalAmountSold - Math.abs(amountChange)); const soldPercent = totalPositionAmountBeforeSale > 0 ? (Math.abs(amountChange) / totalPositionAmountBeforeSale) * 100 : 0; const partialPnl = (price - position.avgBuyPrice); const partialPnlPercent = position.avgBuyPrice > 0 ? (partialPnl / position.avgBuyPrice) * 100 : 0; let msg = `*⚙️ تحديث التوصية: إدارة مركز ${asset} 🟠*\n━━━━━━━━━━━━━━━━━━━━\n`; msg += `*الأصل:* \`${asset}/USDT\`\n`; msg += `*سعر البيع الجزئي:* \`$${formatNumber(price, 4)}\`\n`; msg += `━━━━━━━━━━━━━━━━━━━━\n*استراتيجية إدارة المحفظة:*\n`; msg += ` ▪️ *الإجراء:* تم بيع \`${formatNumber(soldPercent)}%\` من مركزنا لتأمين الأرباح.\n`; msg += ` ▪️ *النتيجة:* ربح محقق على الجزء المباع بنسبة \`${formatNumber(partialPnlPercent)}%\` 🟢.\n`; msg += ` ▪️ *حالة المركز:* لا يزال المركز مفتوحًا بالكمية المتبقية.\n`; msg += `━━━━━━━━━━━━━━━━━━━━\n*ملاحظات:*\nخطوة استباقية لإدارة المخاطر وحماية رأس المال. نستمر في متابعة الأهداف الأعلى.\n`; msg += `#إدارة_مخاطر #${asset}`; return msg; }
function formatPublicClose(details) { const { asset, pnlPercent, durationDays, avgBuyPrice, avgSellPrice } = details; const pnlSign = pnlPercent >= 0 ? '+' : ''; const emoji = pnlPercent >= 0 ? '🟢' : '🔴'; let msg = `*🏆 النتيجة النهائية لتوصية ${asset} ✅*\n━━━━━━━━━━━━━━━━━━━━\n`; msg += `*الأصل:* \`${asset}/USDT\`\n`; msg += `*الحالة:* **تم إغلاق الصفقة بالكامل.**\n`; msg += `━━━━━━━━━━━━━━━━━━━━\n*ملخص أداء التوصية:*\n`; msg += ` ▪️ **متوسط سعر الدخول:** \`$${formatNumber(avgBuyPrice, 4)}\`\n`; msg += ` ▪️ **متوسط سعر الخروج:** \`$${formatNumber(avgSellPrice, 4)}\`\n`; msg += ` ▪️ **العائد النهائي على الاستثمار (ROI):** \`${pnlSign}${formatNumber(pnlPercent)}%\` ${emoji}\n`; msg += ` ▪️ **مدة التوصية:** \`${formatNumber(durationDays, 1)} يوم\`\n`; msg += `━━━━━━━━━━━━━━━━━━━━\n*الخلاصة:*\n`; if (pnlPercent >= 0) { msg += `صفقة موفقة أثبتت أن الصبر على التحليل يؤتي ثماره.\n`; } else { msg += `الخروج بانضباط وفقًا للخطة هو نجاح بحد ذاته. نحافظ على رأس المال للفرصة القادمة.\n`; } msg += `\nنبارك لمن اتبع التوصية. نستعد الآن للبحث عن الفرصة التالية.\n`; msg += `#نتائجتوصيات #${asset}`; return msg; }
async function formatPortfolioMsg(assets, total, capital) { const positions = await loadPositions(); let dailyPnlText = " ▫️ *الأداء اليومي (24س):* `لا توجد بيانات كافية`\n"; let totalValue24hAgo = 0; assets.forEach(asset => { if (asset.asset === 'USDT') totalValue24hAgo += asset.value; else if (asset.change24h !== undefined && asset.price > 0) totalValue24hAgo += asset.amount * (asset.price / (1 + asset.change24h)); else totalValue24hAgo += asset.value; }); if (totalValue24hAgo > 0) { const dailyPnl = total - totalValue24hAgo; const dailyPnlPercent = (dailyPnl / totalValue24hAgo) * 100; const sign = dailyPnl >= 0 ? '+' : ''; dailyPnlText = ` ▫️ *الأداء اليومي (24س):* ${dailyPnl >= 0 ? '🟢⬆️' : '🔴⬇️'} \`${sign}${formatNumber(dailyPnl)}\` (\`${sign}${formatNumber(dailyPnlPercent)}%\`)\n`; } const pnl = capital > 0 ? total - capital : 0; const pnlPercent = capital > 0 ? (pnl / capital) * 100 : 0; const pnlSign = pnl >= 0 ? '+' : ''; const usdtValue = (assets.find(a => a.asset === 'USDT') || { value: 0 }).value; const cashPercent = total > 0 ? (usdtValue / total) * 100 : 0; const liquidityText = ` ▫️ *السيولة:* 💵 نقدي ${formatNumber(cashPercent, 1)}% / 📈 مستثمر ${formatNumber(100 - cashPercent, 1)}%`; let msg = `🧾 *التقرير التحليلي للمحفظة*\n\n`; msg += `*بتاريخ: ${new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo" })}*\n`; msg += `━━━━━━━━━━━━━━━━━━━\n*نظرة عامة على الأداء:*\n`; msg += ` ▫️ *القيمة الإجمالية:* \`$${formatNumber(total)}\`\n`; msg += ` ▫️ *رأس المال:* \`$${formatNumber(capital)}\`\n`; msg += ` ▫️ *إجمالي الربح غير المحقق:* ${pnl >= 0 ? '🟢⬆️' : '🔴⬇️'} \`${pnlSign}${formatNumber(pnl)}\` (\`${pnlSign}${formatNumber(pnlPercent)}%\`)\n`; msg += dailyPnlText + liquidityText + `\n━━━━━━━━━━━━━━━━━━━━\n*مكونات المحفظة:*\n`; assets.forEach((a, index) => { const percent = total > 0 ? (a.value / total) * 100 : 0; msg += "\n"; if (a.asset === "USDT") { msg += `*USDT* (الرصيد النقدي) 💵\n*القيمة:* \`$${formatNumber(a.value)}\` (*الوزن:* \`${formatNumber(percent)}%\`)`; } else { const change24hPercent = (a.change24h || 0) * 100; const changeEmoji = change24hPercent >= 0 ? '🟢⬆️' : '🔴⬇️'; const changeSign = change24hPercent >= 0 ? '+' : ''; msg += `╭─ *${a.asset}/USDT*\n`; msg += `├─ *القيمة الحالية:* \`$${formatNumber(a.value)}\` (*الوزن:* \`${formatNumber(percent)}%\`)\n`; msg += `├─ *سعر السوق:* \`$${formatNumber(a.price, 4)}\`\n`; msg += `├─ *الأداء اليومي:* ${changeEmoji} \`${changeSign}${formatNumber(change24hPercent)}%\`\n`; const position = positions[a.asset]; if (position?.avgBuyPrice > 0) { const totalCost = position.avgBuyPrice * a.amount; const assetPnl = a.value - totalCost; const assetPnlPercent = totalCost > 0 ? (assetPnl / totalCost) * 100 : 0; msg += `├─ *متوسط الشراء:* \`$${formatNumber(position.avgBuyPrice, 4)}\`\n`; msg += `╰─ *ربح/خسارة غير محقق:* ${assetPnl >= 0 ? '🟢' : '🔴'} \`${assetPnl >= 0 ? '+' : ''}${formatNumber(assetPnl)}\` (\`${assetPnl >= 0 ? '+' : ''}${formatNumber(assetPnlPercent)}%\`)`; } else { msg += `╰─ *متوسط الشراء:* \`غير مسجل\``; } } if (index < assets.length - 1) msg += `\n━━━━━━━━━━━━━━━━━━━━`; }); return msg; }
async function formatAdvancedMarketAnalysis() { const prices = await getMarketPrices(); if (!prices) return "❌ فشل جلب بيانات السوق."; const marketData = Object.entries(prices).map(([instId, data]) => ({ instId, ...data })).filter(d => d.volCcy24h > 10000 && d.change24h !== undefined); marketData.sort((a, b) => b.change24h - a.change24h); const topGainers = marketData.slice(0, 5); const topLosers = marketData.slice(-5).reverse(); marketData.sort((a, b) => b.volCcy24h - a.volCcy24h); const highVolume = marketData.slice(0, 5); let msg = `🚀 *تحليل السوق المتقدم* | ${new Date().toLocaleDateString("ar-EG")}\n━━━━━━━━━━━━━━━━━━━\n\n`; msg += "📈 *أكبر الرابحين (24س):*\n" + topGainers.map(c => `  - \`${c.instId}\`: \`+${formatNumber(c.change24h * 100)}%\``).join('\n') + "\n\n"; msg += "📉 *أكبر الخاسرين (24س):*\n" + topLosers.map(c => `  - \`${c.instId}\`: \`${formatNumber(c.change24h * 100)}%\``).join('\n') + "\n\n"; msg += "📊 *الأعلى في حجم التداول:*\n" + highVolume.map(c => `  - \`${c.instId}\`: \`${(c.volCcy24h / 1e6).toFixed(2)}M\` USDT`).join('\n') + "\n\n"; msg += "💡 *توصية:* راقب الأصول ذات حجم التداول المرتفع، فهي غالبًا ما تقود اتجاه السوق."; return msg; }
async function formatQuickStats(assets, total, capital) { const pnl = capital > 0 ? total - capital : 0; const pnlPercent = capital > 0 ? (pnl / capital) * 100 : 0; const statusEmoji = pnl >= 0 ? '🟢' : '🔴'; const statusText = pnl >= 0 ? 'ربح' : 'خسارة'; let msg = "⚡ *إحصائيات سريعة*\n\n"; msg += `💎 *إجمالي الأصول:* \`${assets.filter(a => a.asset !== 'USDT').length}\`\n`; msg += `💰 *القيمة الحالية:* \`$${formatNumber(total)}\`\n`; msg += `📈 *نسبة الربح/الخسارة:* \`${formatNumber(pnlPercent)}%\`\n`; msg += `🎯 *الحالة:* ${statusEmoji} ${statusText}\n\n`; msg += `⏰ *آخر تحديث:* ${new Date().toLocaleTimeString("ar-EG")}`; return msg; }

// =================================================================
// SECTION 4: BACKGROUND JOB FUNCTIONS (CRON)
// =================================================================
async function updatePositionAndAnalyze(asset, amountChange, price, newTotalAmount) { if (!asset || price === undefined || price === null || isNaN(price)) return { analysisResult: null }; const positions = await loadPositions(); let position = positions[asset]; let analysisResult = { type: 'none', data: {} }; if (amountChange > 0) { if (!position) { positions[asset] = { totalAmountBought: amountChange, totalCost: amountChange * price, avgBuyPrice: price, openDate: new Date().toISOString(), totalAmountSold: 0, realizedValue: 0, highestPrice: price, lowestPrice: price }; } else { position.totalAmountBought += amountChange; position.totalCost += (amountChange * price); position.avgBuyPrice = position.totalCost / position.totalAmountBought; } analysisResult.type = 'buy'; } else if (amountChange < 0 && position) { position.realizedValue += (Math.abs(amountChange) * price); position.totalAmountSold += Math.abs(amountChange); if (newTotalAmount * price < 1) { const finalPnl = position.realizedValue - position.totalCost; const finalPnlPercent = position.totalCost > 0 ? (finalPnl / position.totalCost) * 100 : 0; const closeDate = new Date(); const openDate = new Date(position.openDate); const durationDays = (closeDate.getTime() - openDate.getTime()) / (1000 * 60 * 60 * 24); const avgSellPrice = position.totalAmountSold > 0 ? position.realizedValue / position.totalAmountSold : 0; const closeReportData = { asset, pnl: finalPnl, pnlPercent: finalPnlPercent, durationDays, avgBuyPrice: position.avgBuyPrice, avgSellPrice, highestPrice: position.highestPrice, lowestPrice: position.lowestPrice }; await saveClosedTrade(closeReportData); analysisResult = { type: 'close', data: closeReportData }; delete positions[asset]; } else { analysisResult.type = 'sell'; } } await savePositions(positions); analysisResult.data.position = positions[asset] || position; return { analysisResult }; }
async function monitorBalanceChanges() { try { await sendDebugMessage("Checking balance changes..."); const previousState = await loadBalanceState(); const previousBalances = previousState.balances || {}; const oldTotalValue = previousState.totalValue || 0; const oldUsdtValue = previousBalances['USDT'] || 0; const currentBalance = await getBalanceForComparison(); if (!currentBalance) return; const prices = await getMarketPrices(); if (!prices) return; const { assets: newAssets, total: newTotalValue, usdtValue: newUsdtValue } = await getPortfolio(prices); if (newTotalValue === undefined) return; if (Object.keys(previousBalances).length === 0) { await saveBalanceState({ balances: currentBalance, totalValue: newTotalValue }); return; } const allAssets = new Set([...Object.keys(previousBalances), ...Object.keys(currentBalance)]); let stateNeedsUpdate = false; for (const asset of allAssets) { if (asset === 'USDT') continue; const prevAmount = previousBalances[asset] || 0; const currAmount = currentBalance[asset] || 0; const difference = currAmount - prevAmount; const priceData = prices[`${asset}-USDT`]; if (!priceData || !priceData.price || isNaN(priceData.price) || Math.abs(difference * priceData.price) < 1) continue; stateNeedsUpdate = true; const { analysisResult } = await updatePositionAndAnalyze(asset, difference, priceData.price, currAmount); if (analysisResult.type === 'none') continue; const tradeValue = Math.abs(difference) * priceData.price; const newAssetData = newAssets.find(a => a.asset === asset); const newAssetValue = newAssetData ? newAssetData.value : 0; const newAssetWeight = newTotalValue > 0 ? (newAssetValue / newTotalValue) * 100 : 0; const newCashPercent = newTotalValue > 0 ? (newUsdtValue / newTotalValue) * 100 : 0; const baseDetails = { asset, price: priceData.price, amountChange: difference, tradeValue, oldTotalValue, newAssetWeight, newUsdtValue, newCashPercent, oldUsdtValue, position: analysisResult.data.position }; const settings = await loadSettings(); let privateMessage, publicMessage; if (analysisResult.type === 'buy') { privateMessage = formatPrivateBuy(baseDetails); publicMessage = formatPublicBuy(baseDetails); await bot.api.sendMessage(AUTHORIZED_USER_ID, privateMessage, { parse_mode: "Markdown" }); if (settings.autoPostToChannel) { await bot.api.sendMessage(process.env.TARGET_CHANNEL_ID, publicMessage, { parse_mode: "Markdown" }); } } else if (analysisResult.type === 'sell') { privateMessage = formatPrivateSell(baseDetails); publicMessage = formatPublicSell(baseDetails); await bot.api.sendMessage(AUTHORIZED_USER_ID, privateMessage, { parse_mode: "Markdown" }); if (settings.autoPostToChannel) { await bot.api.sendMessage(process.env.TARGET_CHANNEL_ID, publicMessage, { parse_mode: "Markdown" }); } } else if (analysisResult.type === 'close') { privateMessage = formatPrivateCloseReport(analysisResult.data); publicMessage = formatPublicClose(analysisResult.data); if (settings.autoPostToChannel) { await bot.api.sendMessage(process.env.TARGET_CHANNEL_ID, publicMessage, { parse_mode: "Markdown" }); await bot.api.sendMessage(AUTHORIZED_USER_ID, privateMessage, { parse_mode: "Markdown" }); } else { const confirmationKeyboard = new InlineKeyboard().text("✅ نعم، انشر التقرير", "publish_report").text("❌ لا، تجاهل", "ignore_report"); const hiddenMarker = `\n<REPORT>${JSON.stringify(publicMessage)}</REPORT>`; const confirmationMessage = `*تم إغلاق المركز بنجاح. هل تود نشر الملخص في القناة؟*\n\n${privateMessage}${hiddenMarker}`; await bot.api.sendMessage(AUTHORIZED_USER_ID, confirmationMessage, { parse_mode: "Markdown", reply_markup: confirmationKeyboard }); } } } if (stateNeedsUpdate) { await saveBalanceState({ balances: currentBalance, totalValue: newTotalValue }); await sendDebugMessage("State updated after balance change."); } } catch (e) { console.error("CRITICAL ERROR in monitorBalanceChanges:", e); } }
async function trackPositionHighLow() { try { const positions = await loadPositions(); if (Object.keys(positions).length === 0) return; const prices = await getMarketPrices(); if (!prices) return; let positionsUpdated = false; for (const symbol in positions) { const position = positions[symbol]; const currentPrice = prices[`${symbol}-USDT`]?.price; if (currentPrice) { if (!position.highestPrice || currentPrice > position.highestPrice) { position.highestPrice = currentPrice; positionsUpdated = true; } if (!position.lowestPrice || currentPrice < position.lowestPrice) { position.lowestPrice = currentPrice; positionsUpdated = true; } } } if (positionsUpdated) { await savePositions(positions); await sendDebugMessage("Updated position high/low prices."); } } catch(e) { console.error("CRITICAL ERROR in trackPositionHighLow:", e); } }
async function checkPriceAlerts() { try { const alerts = await loadAlerts(); if (alerts.length === 0) return; const prices = await getMarketPrices(); if (!prices) return; const remainingAlerts = []; let triggered = false; for (const alert of alerts) { const currentPrice = prices[alert.instId]?.price; if (currentPrice === undefined) { remainingAlerts.push(alert); continue; } if ((alert.condition === '>' && currentPrice > alert.price) || (alert.condition === '<' && currentPrice < alert.price)) { await bot.api.sendMessage(AUTHORIZED_USER_ID, `🚨 *تنبيه سعر!* \`${alert.instId}\`\nالشرط: ${alert.condition} ${alert.price}\nالسعر الحالي: \`${currentPrice}\``, { parse_mode: "Markdown" }); triggered = true; } else { remainingAlerts.push(alert); } } if (triggered) await saveAlerts(remainingAlerts); } catch (error) { console.error("Error in checkPriceAlerts:", error); } }
async function checkPriceMovements() { try { await sendDebugMessage("Checking price movements..."); const alertSettings = await loadAlertSettings(); const priceTracker = await loadPriceTracker(); const prices = await getMarketPrices(); if (!prices) return; const { assets, total: currentTotalValue, error } = await getPortfolio(prices); if (error || currentTotalValue === undefined) return; if (priceTracker.totalPortfolioValue === 0) { priceTracker.totalPortfolioValue = currentTotalValue; assets.forEach(a => { if (a.price) priceTracker.assets[a.asset] = a.price; }); await savePriceTracker(priceTracker); return; } let trackerUpdated = false; for (const asset of assets) { if (asset.asset === 'USDT' || !asset.price) continue; const lastPrice = priceTracker.assets[asset.asset]; if (lastPrice) { const changePercent = ((asset.price - lastPrice) / lastPrice) * 100; const threshold = alertSettings.overrides[asset.asset] || alertSettings.global; if (Math.abs(changePercent) >= threshold) { const movementText = changePercent > 0 ? 'صعود' : 'هبوط'; const message = `📈 *تنبيه حركة سعر لأصل!* \`${asset.asset}\`\n*الحركة:* ${movementText} بنسبة \`${formatNumber(changePercent)}%\`\n*السعر الحالي:* \`$${formatNumber(asset.price, 4)}\``; await bot.api.sendMessage(AUTHORIZED_USER_ID, message, { parse_mode: "Markdown" }); priceTracker.assets[asset.asset] = asset.price; trackerUpdated = true; } } else { priceTracker.assets[asset.asset] = asset.price; trackerUpdated = true; } } if (trackerUpdated) await savePriceTracker(priceTracker); } catch (e) { console.error("CRITICAL ERROR in checkPriceMovements:", e); } }
async function runDailyJobs() { try { const settings = await loadSettings(); if (!settings.dailySummary) return; const prices = await getMarketPrices(); if (!prices) return; const { total } = await getPortfolio(prices); if (total === undefined) return; const history = await loadHistory(); const date = new Date().toISOString().slice(0, 10); const todayIndex = history.findIndex(h => h.date === date); if (todayIndex > -1) history[todayIndex].total = total; else history.push({ date, total }); if (history.length > 35) history.shift(); await saveHistory(history); console.log(`[Daily Summary Recorded]: ${date} - $${formatNumber(total)}`); } catch (e) { console.error("CRITICAL ERROR in runDailyJobs:", e); } }
async function runHourlyJobs() { try { const prices = await getMarketPrices(); if (!prices) return; const { total } = await getPortfolio(prices); if (total === undefined) return; const history = await loadHourlyHistory(); const hourLabel = new Date().toISOString().slice(0, 13); const existingIndex = history.findIndex(h => h.label === hourLabel); if (existingIndex > -1) history[existingIndex].total = total; else history.push({ label: hourLabel, total }); if (history.length > 72) history.splice(0, history.length - 72); await saveHourlyHistory(history); } catch (e) { console.error("Error in hourly jobs:", e); } }
async function monitorVirtualTrades() {
    try {
        await sendDebugMessage("Cron: Running monitorVirtualTrades...");
        const activeTrades = await getActiveVirtualTrades();
        if (activeTrades.length === 0) {
            await sendDebugMessage("Cron: No active virtual trades found.");
            return;
        }

        const prices = await getMarketPrices();
        if (!prices) {
            await sendDebugMessage("Cron: Could not fetch prices for virtual trades.");
            return;
        }

        await sendDebugMessage(`Cron: Found ${activeTrades.length} active trade(s) to check.`);

        for (const trade of activeTrades) {
            const currentPrice = prices[trade.instId]?.price;
            if (!currentPrice) continue;

            let finalStatus = null;
            let pnl = 0;
            let finalPrice = 0;

            if (currentPrice >= trade.targetPrice) {
                finalPrice = trade.targetPrice;
                pnl = (finalPrice - trade.entryPrice) * (trade.virtualAmount / trade.entryPrice);
                finalStatus = 'completed';
                const profitPercent = (trade.virtualAmount > 0) ? (pnl / trade.virtualAmount) * 100 : 0;
                const msg = `🎯 *الهدف تحقق (توصية افتراضية)!* ✅\n\n` +
                            `*العملة:* \`${trade.instId}\`\n` +
                            `*سعر الدخول:* \`$${formatNumber(trade.entryPrice, 4)}\`\n` +
                            `*سعر الهدف:* \`$${formatNumber(trade.targetPrice, 4)}\`\n\n` +
                            `💰 *الربح المحقق:* \`+$${formatNumber(pnl)}\` (\`+${formatNumber(profitPercent)}%\`)`;
                await bot.api.sendMessage(AUTHORIZED_USER_ID, msg, { parse_mode: "Markdown" });
            } 
            else if (currentPrice <= trade.stopLossPrice) {
                finalPrice = trade.stopLossPrice;
                pnl = (finalPrice - trade.entryPrice) * (trade.virtualAmount / trade.entryPrice);
                finalStatus = 'stopped';
                const lossPercent = (trade.virtualAmount > 0) ? (pnl / trade.virtualAmount) * 100 : 0;
                const msg = `🛑 *تم تفعيل وقف الخسارة (توصية افتراضية)!* 🔻\n\n` +
                            `*العملة:* \`${trade.instId}\`\n` +
                            `*سعر الدخول:* \`$${formatNumber(trade.entryPrice, 4)}\`\n` +
                            `*سعر الوقف:* \`$${formatNumber(trade.stopLossPrice, 4)}\`\n\n` +
                            `💸 *الخسارة:* \`$${formatNumber(pnl)}\` (\`${formatNumber(lossPercent)}%\`)`;
                await bot.api.sendMessage(AUTHORIZED_USER_ID, msg, { parse_mode: "Markdown" });
            }

            if (finalStatus) {
                await sendDebugMessage(`Cron: Virtual trade ${trade.instId} status changing to ${finalStatus}.`);
                await updateVirtualTradeStatus(trade._id, finalStatus, finalPrice);
            }
        }
    } catch (error) {
        console.error("CRITICAL ERROR in monitorVirtualTrades:", error);
        await sendDebugMessage(`Cron Error in monitorVirtualTrades: ${error.message}`);
    }
}

// =================================================================
// SECTION 5: BOT UI AND COMMAND HANDLERS
// =================================================================

const mainKeyboard = new Keyboard()
    .text("📊 عرض المحفظة").text("📈 أداء المحفظة").row()
    .text("🚀 تحليل السوق").text("💡 توصية افتراضية").row()
    .text("⚡ إحصائيات سريعة").text("ℹ️ معلومات عملة").row()
    .text("🔔 ضبط تنبيه").text("🧮 حاسبة الربح والخسارة").row()
    .text("⚙️ الإعدادات").resized();

const virtualTradeKeyboard = new InlineKeyboard()
    .text("➕ إضافة توصية جديدة", "add_virtual_trade").row()
    .text("📈 متابعة التوصيات الحية", "track_virtual_trades");

async function sendSettingsMenu(ctx) {
    const settings = await loadSettings();
    const settingsKeyboard = new InlineKeyboard()
        .text("💰 تعيين رأس المال", "set_capital")
        .text("💼 عرض المراكز المفتوحة", "view_positions").row()
        .text("🚨 إدارة تنبيهات الحركة", "manage_movement_alerts")
        .text("🗑️ حذف تنبيه سعر", "delete_alert").row()
        .text(`📰 الملخص اليومي: ${settings.dailySummary ? '✅' : '❌'}`, "toggle_summary")
        .text(`🚀 النشر للقناة: ${settings.autoPostToChannel ? '✅' : '❌'}`, "toggle_autopost").row()
        .text(`🐞 وضع التشخيص: ${settings.debugMode ? '✅' : '❌'}`, "toggle_debug")
        .text("🔥 حذف جميع البيانات 🔥", "delete_all_data");
    const text = "⚙️ *لوحة التحكم والإعدادات الرئيسية*";
    try {
        if (ctx.callbackQuery) {
            await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: settingsKeyboard });
        } else {
            await ctx.reply(text, { parse_mode: "Markdown", reply_markup: settingsKeyboard });
        }
    } catch(e) {
        console.error("Error sending settings menu:", e);
        await ctx.reply(text, { parse_mode: "Markdown", reply_markup: settingsKeyboard });
    }
}

async function sendMovementAlertsMenu(ctx) {
    const alertSettings = await loadAlertSettings();
    const text = `🚨 *إدارة تنبيهات حركة الأسعار*\n\n- *النسبة العامة الحالية:* \`${alertSettings.global}%\`.\n- يمكنك تعيين نسبة مختلفة لعملة معينة.`;
    const keyboard = new InlineKeyboard()
        .text("📊 تعديل النسبة العامة", "set_global_alert")
        .text("💎 تعديل نسبة عملة", "set_coin_alert").row()
        .text("🔙 العودة للإعدادات", "back_to_settings");
    await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: keyboard });
}

bot.use(async (ctx, next) => {
    if (ctx.from?.id !== AUTHORIZED_USER_ID) {
        console.log(`Unauthorized access attempt by user ID: ${ctx.from?.id}`);
        return;
    }
    await next();
});

bot.command("start", (ctx) => {
    const welcomeMessage = `🤖 *أهلاً بك في بوت OKX التحليلي المتكامل، مساعدك الذكي لإدارة وتحليل محفظتك الاستثمارية.*\n\n` +
        `*الإصدار: v127 - Virtual Trade Fix*\n\n` +
        `أنا هنا لمساعدتك على:\n` +
        `- 📊 تتبع أداء محفظتك لحظة بلحظة.\n` +
        `- 🚀 تحليل اتجاهات السوق والفرص المتاحة.\n` +
        `- 💡 إضافة ومتابعة توصيات افتراضية.\n` +
        `- 🔔 ضبط تنبيهات ذكية للأسعار والحركات الهامة.\n\n` +
        `*اضغط على الأزرار أدناه للبدء!*`;
    ctx.reply(welcomeMessage, { parse_mode: "Markdown", reply_markup: mainKeyboard });
});

bot.command("settings", async (ctx) => {
    await sendSettingsMenu(ctx);
});

bot.command("pnl", async (ctx) => {
    const args = ctx.match.trim().split(/\s+/);
    if (args.length !== 3 || args[0] === '') {
        return await ctx.reply(`❌ *صيغة غير صحيحة.*\n*مثال:* \`/pnl <سعر الشراء> <سعر البيع> <الكمية>\``, { parse_mode: "Markdown" });
    }
    const [buyPrice, sellPrice, quantity] = args.map(parseFloat);
    if (isNaN(buyPrice) || isNaN(sellPrice) || isNaN(quantity) || buyPrice <= 0 || sellPrice <= 0 || quantity <= 0) {
        return await ctx.reply("❌ *خطأ:* تأكد من أن جميع القيم هي أرقام موجبة.");
    }
    const investment = buyPrice * quantity;
    const saleValue = sellPrice * quantity;
    const pnl = saleValue - investment;
    const pnlPercent = (investment > 0) ? (pnl / investment) * 100 : 0;
    const status = pnl >= 0 ? "ربح ✅" : "خسارة 🔻";
    const sign = pnl >= 0 ? '+' : '';
    const msg = `🧮 *نتيجة حساب الربح والخسارة*\n\n` +
                `*صافي الربح/الخسارة:* \`${sign}${formatNumber(pnl)}\` (\`${sign}${formatNumber(pnlPercent)}%\`)\n` +
                `**الحالة النهائية: ${status}**`;
    await ctx.reply(msg, { parse_mode: "Markdown" });
});

bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;

    try {
        if (data.startsWith("chart_")) {
            await ctx.answerCallbackQuery();
            const period = data.split('_')[1];
            await ctx.editMessageText("⏳ جاري إنشاء تقرير الأداء...");
            let history, periodLabel, periodData;
            if (period === '24h') { 
                history = await loadHourlyHistory(); 
                periodLabel = "آخر 24 ساعة"; 
                periodData = history.slice(-24).map(h => ({label: new Date(h.label).getHours() + ':00', total: h.total })); 
            } else if (period === '7d') { 
                history = await loadHistory(); 
                periodLabel = "آخر 7 أيام"; 
                periodData = history.slice(-7).map(h => ({ label: h.date.slice(5), total: h.total })); 
            } else if (period === '30d') { 
                history = await loadHistory(); 
                periodLabel = "آخر 30 يومًا"; 
                periodData = history.slice(-30).map(h => ({ label: h.date.slice(5), total: h.total })); 
            } else {
                return;
            }
            
            if (!periodData || periodData.length < 2) { 
                return await ctx.editMessageText("ℹ️ لا توجد بيانات كافية لهذه الفترة."); 
            }
            const stats = calculatePerformanceStats(periodData);
            if (!stats) { 
                return await ctx.editMessageText("ℹ️ لا توجد بيانات كافية لهذه الفترة."); 
            }
            
            const chartUrl = createChartUrl(periodData, periodLabel, stats.pnl);
            const pnlSign = stats.pnl >= 0 ? '+' : '';
            const caption = `📊 *تحليل أداء المحفظة | ${periodLabel}*\n\n` +
                          `📈 *النتيجة:* ${stats.pnl >= 0 ? '🟢⬆️' : '🔴⬇️'} \`${pnlSign}${formatNumber(stats.pnl)}\` (\`${pnlSign}${formatNumber(stats.pnlPercent)}%\`)\n` +
                          `*التغير الصافي: من \`$${formatNumber(stats.startValue)}\` إلى \`$${formatNumber(stats.endValue)}\`*\n\n` +
                          `📝 *ملخص إحصائيات الفترة:*\n` +
                          ` ▫️ *أعلى قيمة وصلت لها المحفظة:* \`$${formatNumber(stats.maxValue)}\`\n` +
                          ` ▫️ *أدنى قيمة وصلت لها المحفظة:* \`$${formatNumber(stats.minValue)}\`\n` +
                          ` ▫️ *متوسط قيمة المحفظة:* \`$${formatNumber(stats.avgValue)}\`\n\n` +
                          `*التقرير تم إنشاؤه في: ${new Date().toLocaleDateString("en-GB").replace(/\//g, '.')}*`;
            await ctx.replyWithPhoto(chartUrl, { caption: caption, parse_mode: "Markdown" }); 
            await ctx.deleteMessage(); 
            return;
        }

        if (data === "publish_report" || data === "ignore_report") {
            await ctx.answerCallbackQuery();
            const originalMessage = ctx.callbackQuery.message;
            if (!originalMessage) return;
            const originalText = originalMessage.text;
            const reportMarkerIndex = originalText.indexOf("<REPORT>");
            
            if (reportMarkerIndex !== -1) {
                const privatePart = originalText.substring(0, reportMarkerIndex);
                
                if (data === "publish_report") {
                    const markerStart = originalText.indexOf("<REPORT>");
                    const markerEnd = originalText.indexOf("</REPORT>");
                    if (markerStart !== -1 && markerEnd !== -1) {
                        const reportContentString = originalText.substring(markerStart + 8, markerEnd);
                        const reportContent = JSON.parse(reportContentString);
                        await bot.api.sendMessage(process.env.TARGET_CHANNEL_ID, reportContent, { parse_mode: "Markdown" });
                        const newText = privatePart.replace('*تم إغلاق المركز بنجاح. هل تود نشر الملخص في القناة؟*', '✅ *تم نشر التقرير بنجاح في القناة.*');
                        await ctx.editMessageText(newText, { reply_markup: undefined, parse_mode: 'Markdown' });
                    }
                } else {
                    const newText = privatePart.replace('*تم إغلاق المركز بنجاح. هل تود نشر الملخص في القناة؟*', '❌ *تم تجاهل نشر التقرير.*');
                    await ctx.editMessageText(newText, { reply_markup: undefined, parse_mode: 'Markdown' });
                }
            }
            return;
        }
        
        // Acknowledge other callbacks immediately
        await ctx.answerCallbackQuery();

        switch(data) {
            case "add_virtual_trade":
                waitingState = 'add_virtual_trade';
                await ctx.editMessageText(
                    "✍️ *لإضافة توصية افتراضية، أرسل التفاصيل في 5 أسطر منفصلة:*\n\n" +
                    "`BTC-USDT`\n" +
                    "`65000` (سعر الدخول)\n" +
                    "`70000` (سعر الهدف)\n" +
                    "`62000` (وقف الخسارة)\n" +
                    "`1000` (المبلغ الافتراضي)\n\n" +
                    "**ملاحظة:** *لا تكتب كلمات مثل 'دخول' أو 'هدف'، فقط الأرقام والرمز.*",
                    { parse_mode: "Markdown" }
                );
                break;
            case "track_virtual_trades":
                await ctx.editMessageText("⏳ جاري جلب التوصيات النشطة...");
                const activeTrades = await getActiveVirtualTrades();
                if (activeTrades.length === 0) {
                    await ctx.editMessageText("✅ لا توجد توصيات افتراضية نشطة حاليًا.", { reply_markup: virtualTradeKeyboard });
                    return;
                }
                const prices = await getMarketPrices();
                if (!prices) {
                    await ctx.editMessageText("❌ فشل جلب الأسعار، لا يمكن متابعة التوصيات.", { reply_markup: virtualTradeKeyboard });
                    return;
                }
                let reportMsg = "📈 *متابعة حية للتوصيات النشطة:*\n" + "━━━━━━━━━━━━━━━━━━━━\n";
                for (const trade of activeTrades) {
                    const currentPrice = prices[trade.instId]?.price;
                    if (!currentPrice) {
                        reportMsg += `*${trade.instId}:* \`لا يمكن جلب السعر الحالي.\`\n`;
                    } else {
                        const pnl = (currentPrice - trade.entryPrice) * (trade.virtualAmount / trade.entryPrice);
                        const pnlPercent = (trade.virtualAmount > 0) ? (pnl / trade.virtualAmount) * 100 : 0;
                        const sign = pnl >= 0 ? '+' : '';
                        const emoji = pnl >= 0 ? '🟢' : '🔴';

                        reportMsg += `*${trade.instId}* ${emoji}\n` +
                                   ` ▫️ *الدخول:* \`$${formatNumber(trade.entryPrice, 4)}\`\n` +
                                   ` ▫️ *الحالي:* \`$${formatNumber(currentPrice, 4)}\`\n` +
                                   ` ▫️ *ربح/خسارة:* \`${sign}${formatNumber(pnl)}\` (\`${sign}${formatNumber(pnlPercent)}%\`)\n` +
                                   ` ▫️ *الهدف:* \`$${formatNumber(trade.targetPrice, 4)}\`\n` +
                                   ` ▫️ *الوقف:* \`$${formatNumber(trade.stopLossPrice, 4)}\`\n`;
                    }
                    reportMsg += "━━━━━━━━━━━━━━━━━━━━\n";
                }
                await ctx.editMessageText(reportMsg, { parse_mode: "Markdown", reply_markup: virtualTradeKeyboard });
                break;
            case "set_capital": 
                waitingState = 'set_capital'; 
                await ctx.editMessageText("💰 يرجى إرسال المبلغ الجديد لرأس المال (رقم فقط)."); 
                break;
            case "back_to_settings": 
                await sendSettingsMenu(ctx); 
                break;
            case "manage_movement_alerts": 
                await sendMovementAlertsMenu(ctx); 
                break;
            case "set_global_alert": 
                waitingState = 'set_global_alert_state'; 
                await ctx.editMessageText("✍️ يرجى إرسال النسبة العامة الجديدة (مثال: `5`)."); 
                break;
            case "set_coin_alert": 
                waitingState = 'set_coin_alert_state'; 
                await ctx.editMessageText("✍️ يرجى إرسال رمز العملة والنسبة.\n*مثال:*\n`BTC 2.5`"); 
                break;
            case "view_positions":
                const positions = await loadPositions();
                if (Object.keys(positions).length === 0) { 
                    await ctx.editMessageText("ℹ️ لا توجد مراكز مفتوحة.", { reply_markup: new InlineKeyboard().text("🔙 العودة للإعدادات", "back_to_settings") }); 
                    break; 
                }
                let posMsg = "📄 *قائمة المراكز المفتوحة:*\n";
                for (const symbol in positions) {
                    const pos = positions[symbol];
                    posMsg += `\n- *${symbol}:* متوسط الشراء \`$${formatNumber(pos.avgBuyPrice, 4)}\``;
                }
                await ctx.editMessageText(posMsg, { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("🔙 العودة للإعدادات", "back_to_settings") });
                break;
            case "delete_alert":
                const alerts = await loadAlerts();
                if (alerts.length === 0) { 
                    await ctx.editMessageText("ℹ️ لا توجد تنبيهات مسجلة.", { reply_markup: new InlineKeyboard().text("🔙 العودة للإعدادات", "back_to_settings") }); 
                    break; 
                }
                let alertMsg = "🗑️ *اختر التنبيه لحذفه:*\n\n";
                alerts.forEach((alert, i) => { 
                    alertMsg += `*${i + 1}.* \`${alert.instId} ${alert.condition} ${alert.price}\`\n`; 
                });
                alertMsg += "\n*أرسل رقم التنبيه الذي تود حذفه.*";
                waitingState = 'delete_alert_number';
                await ctx.editMessageText(alertMsg, { parse_mode: "Markdown" });
                break;
            case "toggle_summary": 
            case "toggle_autopost": 
            case "toggle_debug": 
                const settings = await loadSettings();
                if (data === 'toggle_summary') settings.dailySummary = !settings.dailySummary;
                else if (data === 'toggle_autopost') settings.autoPostToChannel = !settings.autoPostToChannel;
                else if (data === 'toggle_debug') settings.debugMode = !settings.debugMode;
                await saveSettings(settings);
                // *** FIX: ADDED IMMEDIATE FEEDBACK FOR TOGGLES ***
                if (data === 'toggle_debug') {
                    await ctx.answerCallbackQuery({ text: `🐞 وضع التشخيص الآن ${settings.debugMode ? 'مُفعّل' : 'مُعطّل'}.` });
                }
                await sendSettingsMenu(ctx);
                break;
            case "delete_all_data":
                waitingState = 'confirm_delete_all';
                await ctx.editMessageText("⚠️ *تحذير: هذا الإجراء لا يمكن التراجع عنه!* لحذف كل شيء، أرسل: `تأكيد الحذف`", { parse_mode: "Markdown" });
                break;
        }
    } catch (error) {
        console.error("Error in callback_query handler:", error);
    }
});

bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) return;

    if (waitingState) {
        const state = waitingState;
        waitingState = null;
        
        try {
            switch (state) {
                case 'add_virtual_trade':
                    const lines = text.split('\n').map(line => line.trim());
                    if (lines.length < 5) throw new Error("التنسيق غير صحيح، يجب أن يتكون من 5 أسطر.");
                    const instId = lines[0].toUpperCase();
                    const entryPrice = parseFloat(lines[1]);
                    const targetPrice = parseFloat(lines[2]);
                    const stopLossPrice = parseFloat(lines[3]);
                    const virtualAmount = parseFloat(lines[4]);
                    if (!instId.endsWith('-USDT')) throw new Error("رمز العملة يجب أن ينتهي بـ -USDT.");
                    if ([entryPrice, targetPrice, stopLossPrice, virtualAmount].some(isNaN)) throw new Error("تأكد من أن جميع القيم المدخلة هي أرقام صالحة.");
                    if (entryPrice <= 0 || targetPrice <= 0 || stopLossPrice <= 0 || virtualAmount <= 0) throw new Error("جميع القيم الرقمية يجب أن تكون أكبر من صفر.");
                    if (targetPrice <= entryPrice) throw new Error("سعر الهدف يجب أن يكون أعلى من سعر الدخول.");
                    if (stopLossPrice >= entryPrice) throw new Error("سعر وقف الخسارة يجب أن يكون أقل من سعر الدخول.");
                    const tradeData = { instId, entryPrice, targetPrice, stopLossPrice, virtualAmount, status: 'active', createdAt: new Date() };
                    await saveVirtualTrade(tradeData);
                    await ctx.reply(`✅ *تمت إضافة التوصية الافتراضية بنجاح.*\n\nسيتم إعلامك عند تحقيق الهدف أو تفعيل وقف الخسارة.`, { parse_mode: "Markdown" });
                    break;
                case 'set_capital':
                    const amount = parseFloat(text);
                    if (!isNaN(amount) && amount >= 0) {
                        await saveCapital(amount);
                        await ctx.reply(`✅ *تم تحديث رأس المال إلى:* \`$${formatNumber(amount)}\``, { parse_mode: "Markdown" });
                    } else {
                        await ctx.reply("❌ مبلغ غير صالح.");
                    }
                    break;
                case 'set_global_alert_state':
                    const percent = parseFloat(text);
                    if (!isNaN(percent) && percent > 0) {
                        const alertSettingsGlobal = await loadAlertSettings();
                        alertSettingsGlobal.global = percent;
                        await saveAlertSettings(alertSettingsGlobal);
                        await ctx.reply(`✅ تم تحديث النسبة العامة لتنبيهات الحركة إلى \`${percent}%\`.`);
                    } else {
                         await ctx.reply("❌ *خطأ:* النسبة يجب أن تكون رقمًا موجبًا.");
                    }
                    break;
                case 'set_coin_alert_state':
                    const parts_coin_alert = text.split(/\s+/);
                    if (parts_coin_alert.length !== 2) {
                        await ctx.reply("❌ *صيغة غير صحيحة*. يرجى إرسال رمز العملة ثم النسبة.");
                        return;
                    }
                    const [symbol_coin_alert, percentStr_coin_alert] = parts_coin_alert;
                    const coinPercent = parseFloat(percentStr_coin_alert);
                    if (isNaN(coinPercent) || coinPercent < 0) {
                        await ctx.reply("❌ *خطأ:* النسبة يجب أن تكون رقمًا.");
                        return;
                    }
                    const alertSettingsCoin = await loadAlertSettings();
                    if (coinPercent === 0) {
                        delete alertSettingsCoin.overrides[symbol_coin_alert.toUpperCase()];
                        await ctx.reply(`✅ تم حذف الإعداد المخصص لـ *${symbol_coin_alert.toUpperCase()}* وستتبع الآن النسبة العامة.`);
                    } else {
                        alertSettingsCoin.overrides[symbol_coin_alert.toUpperCase()] = coinPercent;
                        await ctx.reply(`✅ تم تحديث النسبة المخصصة لـ *${symbol_coin_alert.toUpperCase()}* إلى \`${coinPercent}%\`.`);
                    }
                    await saveAlertSettings(alertSettingsCoin);
                    break;
                case 'confirm_delete_all':
                    if (text === 'تأكيد الحذف') {
                        const db = getDB();
                        const keys = await db.keys('config:*');
                        if(keys.length > 0) await db.del(...keys);
                        await db.del('tradeHistory', 'virtualTrades');
                        await ctx.reply("✅ تم حذف جميع بياناتك.");
                    } else {
                        await ctx.reply("❌ تم إلغاء الحذف.");
                    }
                    break;
                case 'coin_info':
                    const instIdInfo = text.toUpperCase().endsWith('-USDT') ? text.toUpperCase() : `${text.toUpperCase()}-USDT`;
                    const coinSymbol = instIdInfo.split('-')[0];
                    const loadingMsg = await ctx.reply(`⏳ جاري تجهيز التقرير لـ ${instIdInfo}...`);
                    try {
                        const [details, prices, historicalPerf, techAnalysis] = await Promise.all([
                            getInstrumentDetails(instIdInfo), getMarketPrices(), getHistoricalPerformance(coinSymbol), getTechnicalAnalysis(instIdInfo)
                        ]);
                        if (details.error || !prices) throw new Error(details.error || "فشل جلب البيانات");
                        let msg = `ℹ️ *الملف التحليلي الكامل | ${instIdInfo}*\n\n*القسم الأول: بيانات السوق*\n`;
                        msg += ` ▫️ *السعر الحالي:* \`$${formatNumber(details.price, 4)}\`\n`;
                        msg += ` ▫️ *أعلى (24س):* \`$${formatNumber(details.high24h, 4)}\`\n`;
                        msg += ` ▫️ *أدنى (24س):* \`$${formatNumber(details.low24h, 4)}\`\n\n`;
                        msg += `*القسم الثاني: تحليل مركزك الحالي*\n`;
                        const { assets: userAssets } = await getPortfolio(prices);
                        const ownedAsset = userAssets.find(a => a.asset === coinSymbol);
                        const positions = await loadPositions();
                        const assetPosition = positions[coinSymbol];
                        if (ownedAsset && assetPosition?.avgBuyPrice) {
                            const pnl = (details.price - assetPosition.avgBuyPrice) * ownedAsset.amount;
                            const pnlPercent = (assetPosition.avgBuyPrice * ownedAsset.amount > 0) ? (pnl / (assetPosition.avgBuyPrice * ownedAsset.amount)) * 100 : 0;
                            const durationDays = (new Date().getTime() - new Date(assetPosition.openDate).getTime()) / (1000 * 60 * 60 * 24);
                            msg += ` ▪️ *متوسط الشراء:* \`$${formatNumber(assetPosition.avgBuyPrice, 4)}\`\n`;
                            msg += ` ▪️ *الربح/الخسارة غير المحقق:* ${pnl >= 0 ? '🟢' : '🔴'} \`${pnl >= 0 ? '+' : ''}${formatNumber(pnl)}\` (\`${pnl >= 0 ? '+' : ''}${formatNumber(pnlPercent)}%\`)\n`;
                            msg += ` ▪️ *مدة فتح المركز:* \`${formatNumber(durationDays, 1)} يوم\`\n\n`;
                        } else {
                            msg += ` ▪️ لا يوجد مركز مفتوح حالياً لهذه العملة.\n\n`;
                        }
                        msg += `*القسم الثالث: تاريخ أدائك مع العملة*\n`;
                        if (historicalPerf?.tradeCount > 0) {
                            msg += ` ▪️ *إجمالي الربح/الخسارة المحقق:* \`${historicalPerf.realizedPnl >= 0 ? '+' : ''}${formatNumber(historicalPerf.realizedPnl)}\`\n`;
                            msg += ` ▪️ *سجل الصفقات:* \`${historicalPerf.tradeCount}\` (${historicalPerf.winningTrades} رابحة / ${historicalPerf.losingTrades} خاسرة)\n\n`;
                        } else {
                            msg += ` ▪️ لا يوجد تاريخ صفقات مغلقة لهذه العملة.\n\n`;
                        }
                        msg += `*القسم الرابع: مؤشرات فنية بسيطة*\n`;
                        if (techAnalysis.error) {
                             msg += ` ▪️ ${techAnalysis.error}\n`;
                        } else {
                            let rsiText = "محايد";
                            if (techAnalysis.rsi > 70) rsiText = "تشبع شرائي 🔴";
                            if (techAnalysis.rsi < 30) rsiText = "تشبع بيعي 🟢";
                            msg += ` ▪️ *RSI (14D):* \`${formatNumber(techAnalysis.rsi)}\` (${rsiText})\n`;
                            if(techAnalysis.sma20) msg += ` ▪️ *السعر* *${details.price > techAnalysis.sma20 ? 'فوق' : 'تحت'}* *SMA20* (\`$${formatNumber(techAnalysis.sma20, 4)}\`)\n`;
                            if(techAnalysis.sma50) msg += ` ▪️ *السعر* *${details.price > techAnalysis.sma50 ? 'فوق' : 'تحت'}* *SMA50* (\`$${formatNumber(techAnalysis.sma50, 4)}\`)`;
                        }
                        await bot.api.editMessageText(loadingMsg.chat.id, loadingMsg.message_id, msg, { parse_mode: "Markdown" });
                    } catch(e) {
                        await bot.api.editMessageText(loadingMsg.chat.id, loadingMsg.message_id, `❌ حدث خطأ أثناء جلب البيانات: ${e.message}`);
                    }
                    break;
                case 'set_alert':
                    const parts_alert = text.trim().split(/\s+/);
                    if (parts_alert.length !== 3) {
                        await ctx.reply("❌ صيغة غير صحيحة. مثال: `BTC > 50000`");
                        return;
                    }
                    const [symbol, cond, priceStr] = parts_alert;
                    if (cond !== '>' && cond !== '<') {
                        await ctx.reply("❌ الشرط غير صالح. استخدم `>` أو `<`.");
                        return;
                    }
                    const price = parseFloat(priceStr);
                    if (isNaN(price) || price <= 0) {
                        await ctx.reply("❌ السعر غير صالح.");
                        return;
                    }
                    const allAlerts = await loadAlerts();
                    allAlerts.push({ instId: symbol.toUpperCase() + '-USDT', condition: cond, price: price });
                    await saveAlerts(allAlerts);
                    await ctx.reply(`✅ تم ضبط التنبيه: ${symbol.toUpperCase()} ${cond} ${price}`, { parse_mode: "Markdown" });
                    break;
                case 'delete_alert_number':
                    let currentAlerts = await loadAlerts();
                    const index = parseInt(text) - 1;
                    if (isNaN(index) || index < 0 || index >= currentAlerts.length) {
                        await ctx.reply("❌ رقم غير صالح.");
                        return;
                    }
                    currentAlerts.splice(index, 1);
                    await saveAlerts(currentAlerts);
                    await ctx.reply(`✅ تم حذف التنبيه.`);
                    break;
            }
        } catch (e) {
            console.error(`Error in waitingState handler ('${state}'):`, e);
            await ctx.reply("حدث خطأ أثناء معالجة طلبك.");
        }
        return;
    }
    
    switch (text) {
        case "📊 عرض المحفظة":
            const loadingMsgPortfolio = await ctx.reply("⏳ جاري إعداد التقرير...");
            try {
                const prices = await getMarketPrices();
                if (!prices) throw new Error("فشل جلب أسعار السوق.");
                const capital = await loadCapital();
                const { assets, total, error } = await getPortfolio(prices);
                if (error) throw new Error(error);
                const msgPortfolio = await formatPortfolioMsg(assets, total, capital);
                await bot.api.editMessageText(loadingMsgPortfolio.chat.id, loadingMsgPortfolio.message_id, msgPortfolio, { parse_mode: "Markdown" });
            } catch (e) {
                await bot.api.editMessageText(loadingMsgPortfolio.chat.id, loadingMsgPortfolio.message_id, `❌ حدث خطأ: ${e.message}`);
            }
            break;
        case "🚀 تحليل السوق":
            const loadingMsgMarket = await ctx.reply("⏳ جاري تحليل السوق...");
            try {
                const marketMsg = await formatAdvancedMarketAnalysis();
                await bot.api.editMessageText(loadingMsgMarket.chat.id, loadingMsgMarket.message_id, marketMsg, { parse_mode: "Markdown" });
            } catch (e) {
                await bot.api.editMessageText(loadingMsgMarket.chat.id, loadingMsgMarket.message_id, `❌ حدث خطأ أثناء تحليل السوق.`);
            }
            break;
        case "💡 توصية افتراضية":
             await ctx.reply("اختر الإجراء المطلوب للتوصيات الافتراضية:", { reply_markup: virtualTradeKeyboard });
            break;
        case "⚡ إحصائيات سريعة":
            const loadingMsgQuick = await ctx.reply("⏳ جاري حساب الإحصائيات...");
            try {
                const prices = await getMarketPrices();
                if (!prices) throw new Error("فشل جلب أسعار السوق.");
                const capital = await loadCapital();
                const { assets, total, error } = await getPortfolio(prices);
                if (error) throw new Error(error);
                const quickStatsMsg = await formatQuickStats(assets, total, capital);
                await bot.api.editMessageText(loadingMsgQuick.chat.id, loadingMsgQuick.message_id, quickStatsMsg, { parse_mode: "Markdown" });
            } catch (e) {
                await bot.api.editMessageText(loadingMsgQuick.chat.id, loadingMsgQuick.message_id, `❌ حدث خطأ: ${e.message}`);
            }
            break;
        case "📈 أداء المحفظة":
            const performanceKeyboard = new InlineKeyboard()
                .text("آخر 24 ساعة", "chart_24h")
                .text("آخر 7 أيام", "chart_7d").row()
                .text("آخر 30 يومًا", "chart_30d");
            await ctx.reply("اختر الفترة الزمنية لعرض تقرير الأداء:", { reply_markup: performanceKeyboard });
            break;
        case "ℹ️ معلومات عملة":
            waitingState = 'coin_info';
            await ctx.reply("✍️ يرجى إرسال رمز العملة (مثال: `BTC-USDT`).");
            break;
        case "⚙️ الإعدادات":
            await sendSettingsMenu(ctx);
            break;
        case "🔔 ضبط تنبيه":
            waitingState = 'set_alert';
            await ctx.reply("✍️ *لضبط تنبيه سعر، استخدم الصيغة:*\n`BTC > 50000`", { parse_mode: "Markdown" });
            break;
        case "🧮 حاسبة الربح والخسارة":
            await ctx.reply("✍️ لحساب الربح/الخسارة، استخدم أمر `/pnl` بالصيغة التالية:\n`/pnl <سعر الشراء> <سعر البيع> <الكمية>`", {parse_mode: "Markdown"});
            break;
    }
});


// =================================================================
// SECTION 6: VERCEL SERVER HANDLER
// =================================================================
const app = express();
app.use(express.json());

connectDB();

const webhookHandler = webhookCallback(bot, "express");
app.post("/api/bot", (req, res) => {
    webhookHandler(req, res).catch(err => {
        console.error("Error in webhook handler:", err);
        res.status(500).send("Error processing update");
    });
});

app.get("/api/cron", async (req, res) => {
    if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).send('Unauthorized');
    }
    
    try {
        console.log("Cron job triggered...");
        await Promise.all([
            monitorBalanceChanges(),
            trackPositionHighLow(),
            checkPriceAlerts(),
            checkPriceMovements(),
            monitorVirtualTrades(),
            runHourlyJobs(),
            runDailyJobs()
        ]);
        console.log("Cron jobs finished successfully.");
        res.status(200).send("Cron jobs executed successfully.");
    } catch (e) {
        console.error("CRITICAL ERROR during cron execution:", e);
        res.status(500).send("Cron jobs failed.");
    }
});

app.get("/", (req, res) => {
    res.status(200).send("OKX Advanced Analytics Bot v126 is alive.");
});

module.exports = app;
