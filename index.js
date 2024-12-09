const sqlite3 = require("sqlite3").verbose();
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const technicalindicators = require("technicalindicators");
require("dotenv").config();

function escapeMarkdown(text) {
    if (!text) return text; // Return if text is null/undefined
    return text
        .replace(/_/g, "\\_") // Escape underscores
        .replace(/\*/g, "\\*") // Escape asterisks
        .replace(/\[/g, "\\[") // Escape open square brackets
        .replace(/\]/g, "\\]") // Escape close square brackets
        .replace(/\(/g, "\\(") // Escape open parentheses
        .replace(/\)/g, "\\)") // Escape close parentheses
        .replace(/~/g, "\\~") // Escape tilde
        .replace(/`/g, "\\`") // Escape backtick
        .replace(/>/g, "\\>") // Escape greater-than symbol
        .replace(/#/g, "\\#") // Escape hashtag
        .replace(/\+/g, "\\+") // Escape plus sign
        .replace(/-/g, "\\-") // Escape minus sign
        .replace(/=/g, "\\=") // Escape equal sign
        .replace(/\|/g, "\\|") // Escape pipe
        .replace(/{/g, "\\{") // Escape open curly brace
        .replace(/}/g, "\\}") // Escape close curly brace
        .replace(/\./g, "\\.") // Escape period
        .replace(/!/g, "\\!"); // Escape exclamation mark
}

// Telegram and API setup
// Telegram Bot Setup
const botToken = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHANNEL_ID;
const bot = new TelegramBot(botToken, { polling: true });
const TWELVE_DATA_API_URL = "https://api.twelvedata.com/time_series";
const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY; // Ensure the key is stored in your .env file
// State Variables
const symbols = ["EUR/USD", "GBP/JPY"];

const interval = "5min";
const limit = 150;
let activeSignals = {};
let totalROI = 0;

// ** Initialize Bot **
function initializeBot() {
    console.log("Initializing bot...");
    initializeDatabase();
    loadBotState();
    console.log("Bot initialized successfully. Starting monitoring...");
    setInterval(monitorSignals, 60000); // Monitor every minute
}

// ** Database Setup **
const db = new sqlite3.Database("bot.db", (err) => {
    if (err) console.error("Error connecting to DB:", err.message);
    else console.log("Connected to SQLite database.");
});

// ** Create Database Tables **
function initializeDatabase() {
    db.run(`
        CREATE TABLE IF NOT EXISTS signals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            crypto TEXT NOT NULL,
            signal TEXT NOT NULL,
            entryPrice FLOAT NOT NULL,
            trailingStop FLOAT NOT NULL,
            trailingDistance FLOAT NOT NULL,
            exitPrice FLOAT DEFAULT NULL,
            roi FLOAT DEFAULT 0,
            outcome TEXT,
            createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
            lastTSLUpdate TEXT,
            customId TEXT UNIQUE
        )
    `, (err) => {
        if (err) console.error("Error creating 'signals' table:", err.message);
    });

    db.run(`
        CREATE TABLE IF NOT EXISTS state (
            key TEXT PRIMARY KEY,
            value TEXT
        )
    `, (err) => {
        if (err) console.error("Error creating 'state' table:", err.message);
    });
}


// ** Load Bot State from DB **
function loadBotState() {
    db.all(`SELECT * FROM signals WHERE outcome IS NULL`, [], (err, rows) => {
        if (err) {
            console.error("Error loading active signals:", err.message);
        } else {
            rows.forEach((row) => {
                activeSignals[row.crypto] = {
                    uniqueId: row.customId,
                    crypto: row.crypto,
                    signal: row.signal,
                    entryPrice: parseFloat(row.entryPrice),
                    trailingStop: parseFloat(row.trailingStop),
                    trailingDistance: parseFloat(row.trailingDistance),
                    outcome: row.outcome,
                    lastTSLUpdate: row.lastTSLUpdate,
                    createdAt: row.createdAt,
                };
            });
            console.log("Active signals loaded:", activeSignals);
        }
    });

    // Ensure activeSignals is initialized even if no data is loaded
    activeSignals = activeSignals || {};

    db.get(`SELECT value FROM state WHERE key = 'totalROI'`, [], (err, row) => {
        if (err) {
            console.error("Error loading total ROI:", err.message);
        } else {
            totalROI = row ? parseFloat(row.value) : 0;
            console.log("Total ROI loaded:", totalROI);
        }
    });
}
// Calculate indicators
function calculateIndicators(candles) {
    if (candles.length < 50) {
        console.log("Not enough candles to calculate indicators.");
        return null;
    }
    const closes = candles.map((c) => c.close);
    const highs = candles.map((c) => c.high);
    const lows = candles.map((c) => c.low);

    const emaFast = technicalindicators.EMA.calculate({
        values: closes,
        period: 20,
    });
    const emaSlow = technicalindicators.EMA.calculate({
        values: closes,
        period: 50,
    });
    const rsi = technicalindicators.RSI.calculate({
        values: closes,
        period: 14,
    });
    const macd = technicalindicators.MACD.calculate({
        values: closes,
        fastPeriod: 12,
        slowPeriod: 26,
        signalPeriod: 9,
        SimpleMAOscillator: false,
        SimpleMASignal: false,
    });
    const atr = technicalindicators.ATR.calculate({
        high: highs,
        low: lows,
        close: closes,
        period: 14,
    });
    if (emaFast.length === 0 || emaSlow.length === 0 || macd.length === 0) {
        console.log("EMA or MACD calculation failed.");
        return null;
    }


    // CPR Levels
    const highPrev = Math.max(...highs.slice(-1));
    const lowPrev = Math.min(...lows.slice(-1));
    const closePrev = closes[closes.length - 2];
    const pp = (highPrev + lowPrev + closePrev) / 3;
    const bc = (highPrev + lowPrev) / 2;
    const tc = (pp + bc) / 2;

    return {
        emaFast: emaFast[emaFast.length - 1],
        emaSlow: emaSlow[emaSlow.length - 1],
        rsi: rsi[rsi.length - 1],
        macdLine: macd[macd.length - 1]?.MACD,
        signalLine: macd[macd.length - 1]?.signal,
        atr: atr[atr.length - 1],
        cprUpper: tc,
        cprLower: bc,
    };
}



// ** Monitor Signals **
// ** Monitor Signals **
async function monitorSignals() {
    console.log("Monitoring signals...");

    const fetchPromises = symbols.map(async (symbol) => {
        try {
            console.log(`Fetching data for ${symbol} with interval: ${interval}`);
            const candles = await fetchCandles(symbol);

            if (!candles || candles.length < 50) {
                console.log(`Not enough data to process ${symbol}.`);
                return;
            }

            const indicators = calculateIndicators(candles);

            // Retrieve the active signal for the current symbol
            const activeSignal = activeSignals[symbol];

            if (activeSignal) {
                console.log(`[${symbol}] Active signal found. Monitoring for trailing stop.`);
                handleTrailingStop(symbol, candles[candles.length - 1].close, activeSignal);
            } else {
                console.log(`[${symbol}] No active signal. Attempting to generate a new signal.`);
                generateSignal(symbol, indicators, candles);
            }
        } catch (error) {
            console.error(`Error monitoring ${symbol}:`, error.message);
        }
    });

    await Promise.all(fetchPromises);
    console.log("All signals monitored successfully.");
    // Send active signal status periodically (e.g., every 10 minutes)
    const now = Date.now();
    if (!monitorSignals.lastStatusUpdate || now - monitorSignals.lastStatusUpdate >= 10 * 60 * 1000) {
        await sendActiveSignalStatus();
        monitorSignals.lastStatusUpdate = now;
    }

}


// ** Fetch Candle Data from Binance API **
async function fetchCandles(symbol) {
    try {
        console.log(`Fetching data for ${symbol} with interval: ${interval}`);
        const response = await axios.get(TWELVE_DATA_API_URL, {
            params: {
                symbol: symbol,
                interval: interval,
                outputsize: limit,
                apikey: TWELVE_DATA_API_KEY,
            },
        });

        if (response.data && response.data.values) {
            const candles = response.data.values.map((value) => ({
                time: new Date(value.datetime),
                open: parseFloat(value.open),
                close: parseFloat(value.close),
                high: parseFloat(value.high),
                low: parseFloat(value.low),
                volume: parseFloat(value.volume),
            }));

            console.log(`Fetched ${candles.length} candles for ${symbol}`);
            return candles.reverse(); // Reverse to match chronological order
        } else {
            console.error(`Unexpected response format for ${symbol}:`, response.data);
            return [];
        }
    } catch (error) {
        console.error(`Error fetching candles for ${symbol}:`, error.message);
        return [];
    }
}

async function fetchLatestPrice(symbol) {
    try {
        console.log(`Fetching latest price for ${symbol}`);
        const response = await axios.get(TWELVE_DATA_API_URL, {
            params: {
                symbol: symbol,
                interval: "1min", // Use the smallest interval for the latest price
                outputsize: 1,    // Fetch only the latest candle
                apikey: TWELVE_DATA_API_KEY,
            },
        });

        if (response.data && response.data.values && response.data.values.length > 0) {
            const latestPrice = parseFloat(response.data.values[0].close);
            console.log(`Latest price for ${symbol}: $${latestPrice}`);
            return latestPrice;
        } else {
            console.error(`Unexpected response format for latest price of ${symbol}:`, response.data);
            return null;
        }
    } catch (error) {
        console.error(`Error fetching latest price for ${symbol}:`, error.message);
        return null;
    }
}

function getDecimalPlaces(symbol) {
    if (symbol === "EUR/USD") return 4; // EUR/USD needs 4 decimal places
    if (symbol === "GBP/JPY") return 2; // GBP/JPY needs 2 decimal places
    return 2; // Default to 2 decimal places for other pairs
}



// ** Generate Signal (BUY/SELL Logic) **
function generateSignal(symbol, indicators, candles) {
    const { emaFast, emaSlow, rsi, macdLine, signalLine, atr, cprUpper, cprLower } = indicators;
    const close = candles[candles.length - 1].close;
    const decimalPlaces = getDecimalPlaces(symbol);


    // Signal conditions based on EMA, RSI, and MACD
    const isBuySignal = close > cprUpper &&
        emaFast > emaSlow &&
        rsi > 50 &&
        macdLine > signalLine &&
        macdLine > 0;

    const isSellSignal = close < cprLower &&
        emaFast < emaSlow &&
        rsi < 50 &&
        macdLine < signalLine &&
        macdLine < 0;

    if (isBuySignal || isSellSignal) {
        const signalType = isBuySignal ? "BUY" : "SELL";

        // Trailing Stop Loss is set based on ATR
        const trailingStop = isBuySignal
            ? close - atr * 1.5 // 1.5x ATR below entry price for BUY
            : close + atr * 1.5; // 1.5x ATR above entry price for SELL

        const trailingDistance = atr * 1.5;

        const signal = {
            uniqueId: `${symbol}_${Date.now()}`, // Add unique ID
            crypto: symbol,
            signal: signalType,
            entryPrice: parseFloat(close.toFixed(decimalPlaces)),
            trailingStop: parseFloat(trailingStop.toFixed(decimalPlaces)),
            trailingDistance: parseFloat(trailingDistance.toFixed(decimalPlaces)),
            outcome: null,
            createdAt: new Date().toISOString(),
        };

        activeSignals[symbol] = signal;
        saveSignalToDB(signal);

        // Notify Telegram
        sendTelegramMessage(signal, "New Signal Generated");
        console.log(`[${symbol}] New ${signalType} signal generated.`);
    } else {
        console.log(`[${symbol}] No signal generated.`);
    }
}
function saveBotState() {
    // Save total ROI
    db.run(
        `INSERT INTO state (key, value) VALUES ('totalROI', ?) ON CONFLICT(key) DO UPDATE SET value = ?`,
        [totalROI, totalROI],
        (err) => {
            if (err) console.error("Error saving total ROI:", err.message);
            else console.log("Total ROI saved to DB.");
        }
    );

    // Save active signals
    for (const symbol in activeSignals) {
        const signal = activeSignals[symbol];
        db.run(
            `INSERT INTO signals (uniqueId, crypto, signal, entryPrice, trailingStop, trailingDistance, outcome, createdAt, closedAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(uniqueId) DO UPDATE SET trailingStop = ?, trailingDistance = ?, outcome = ?, closedAt = ?`,
            [
                signal.uniqueId,
                signal.crypto,
                signal.signal,
                signal.entryPrice,
                signal.trailingStop,
                signal.trailingDistance,
                signal.outcome || "Active",
                signal.createdAt,
                signal.closedAt || null,
                signal.trailingStop,
                signal.trailingDistance,
                signal.outcome || "Active",
                signal.closedAt || null,
            ],
            (err) => {
                if (err) console.error(`Error saving signal for ${signal.crypto}:`, err.message);
            }
        );
    }
}

// Periodically save bot state
setInterval(saveBotState, 60000); // Save every minute

// ** Handle Trailing Stop **
function handleTrailingStop(symbol, currentPrice, signal) {
    if (!signal || typeof signal !== "object") {
        console.error(`[${symbol}] Invalid or missing signal object.`, signal);
        return;
    }
    const decimalPlaces = getDecimalPlaces(symbol); // Get decimal places

    const newTrailingStop =
        signal.signal === "BUY"
            ? Math.max(signal.trailingStop, currentPrice - signal.trailingDistance)
            : Math.min(signal.trailingStop, currentPrice + signal.trailingDistance);

    if (
        (signal.signal === "BUY" && currentPrice <= signal.trailingStop) ||
        (signal.signal === "SELL" && currentPrice >= signal.trailingStop)
    ) {
        const reason = currentPrice > signal.entryPrice
            ? "TSL Hit with Profit"
            : "TSL Hit with Loss";

        closeSignal(symbol, signal, currentPrice, reason);

    } else if (newTrailingStop !== signal.trailingStop) {
        signal.trailingStop = newTrailingStop;


        // Notify Telegram about the updated trailing stop
        sendTelegramMessage(
            {
                crypto: symbol,
                signal: signal.signal,
                entryPrice: signal.entryPrice.toFixed(decimalPlaces),
                trailingStop: newTrailingStop.toFixed(decimalPlaces),
                trailingDistance: signal.trailingDistance.toFixed(decimalPlaces),
                outcome: "Active",
                createdAt: signal.createdAt,
            },
            "Trailing Stop Updated"
        );
        // Update the trailing stop in the database
        updateTrailingStopInDB(signal);

    }
}
function calculateROI(entryPrice, exitPrice, signalType) {
    if (!entryPrice || !exitPrice || !signalType) {
        console.error("Invalid parameters for ROI calculation.");
        return 0; // Return 0 if parameters are invalid
    }

    const roi =
        signalType === "BUY"
            ? ((exitPrice - entryPrice) / entryPrice) * 100
            : ((entryPrice - exitPrice) / entryPrice) * 100;

    return parseFloat(roi.toFixed(2)); // Return ROI rounded to 2 decimal places
}


// ** Close Signal **
function closeSignal(symbol, signal, currentPrice, reason) {
    const roi = calculateROI(signal.entryPrice, currentPrice, signal.signal);

    totalROI += roi;
    signal.outcome = "CLOSED";
    signal.roi = roi;
    signal.exitPrice = currentPrice;
    signal.closedAt = new Date().toISOString();
    db.run(
        `UPDATE signals SET outcome = ?, roi = ?, exitPrice = ?, closedAt = ? WHERE uniqueId = ?`,
        [signal.outcome, roi, signal.exitPrice, signal.closedAt, signal.uniqueId],
        (err) => {
            if (err) console.error("Error updating signal in DB:", err.message);
        }
    );

    delete activeSignals[symbol];

    console.log(`[${symbol}] Signal closed with ROI: ${roi.toFixed(2)}% (${signal.outcome}).`);

    sendTelegramMessage(
        {
            ...signal,
            reason,
            currentPrice,
        },
        "Signal Closed"
    );
}

// ** Save Signal to DB **
function saveSignalToDB(signal) {
    if (!signal) {
        console.error("Signal object is undefined or invalid.");
        return;
    }
    db.run(
        `INSERT INTO signals (crypto, signal, entryPrice, trailingStop, trailingDistance, outcome, createdAt, lastTSLUpdate, customId)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            signal.crypto,
            signal.signal,
            signal.entryPrice,
            signal.trailingStop,
            signal.trailingDistance,
            signal.outcome || null,
            new Date().toISOString(), // `createdAt`
            new Date().toISOString(), // `lastTSLUpdate`
            signal.uniqueId || `#${signal.crypto}${Date.now()}`, // Generate a unique customId
        ],
        (err) => {
            if (err) {
                console.error("Error saving signal to DB:", err.message);
            } else {
                console.log(`Signal saved to DB for ${signal.crypto}.`);
            }
        }
    );
}

function updateTrailingStopInDB(signal) {
    db.run(
        `UPDATE signals SET trailingStop = ?, lastTSLUpdate = ? WHERE crypto = ? AND outcome IS NULL`,
        [signal.trailingStop, new Date().toISOString(), signal.crypto],
        (err) => {
            if (err) {
                console.error(`Error updating trailing stop for ${signal.crypto}:`, err.message);
            } else {
                console.log(`Trailing stop updated for ${signal.crypto} in DB.`);
            }
        }
    );

    activeSignals[signal.crypto] = signal; // Update the signal in memory
}

async function sendTelegramMessage(signal, messageType) {
    if (!signal || typeof signal !== "object") {
        console.error("Invalid signal object. Cannot send message.", signal);
        return;
    }
    const decimalPlaces = getDecimalPlaces(signal.crypto); // Get the decimal places based on the pair
    // Dynamically determine the heading based on the type of update
    let heading = "";
    switch (messageType) {
        case "New Signal Generated":
            heading = "📊 **New Trading Signal** 📊";
            break;
        case "Trailing Stop Updated":
            heading = "📉 **Trailing Stop Updated** 📉";
            break;
        case "Signal Closed":
            heading = "📊 **Signal Closed** 📊";
            break;
        case "Active Signal Status":
            heading = "📊 **Active Signal Status** 📊";
            break;
        default:
            console.error("Invalid message type provided:", messageType);
            return; // Exit if an invalid type is passed
    }

    // Create a well-formatted message
    const message = `
${escapeMarkdown(heading)}

🔹 **Signal ID**: ${escapeMarkdown(signal.uniqueId || "N/A")}
🔹 **Crypto**: ${escapeMarkdown(signal.crypto || "N/A")}
🔹 **Signal Type**: ${escapeMarkdown(signal.signal || "N/A")}
🔹 **Entry Price**: $${signal.entryPrice ? escapeMarkdown(signal.entryPrice.toFixed(decimalPlaces)) : "N/A"}
🔹 **Exit Price**: $${signal.exitPrice ? escapeMarkdown(signal.exitPrice.toFixed(decimalPlaces)) : "N/A"}
🔹 **Trailing Stop**: $${signal.trailingStop ? escapeMarkdown(signal.trailingStop.toFixed(decimalPlaces)) : "N/A"}
🔹 **Trailing Distance**: $${signal.trailingDistance ? escapeMarkdown(signal.trailingDistance.toFixed(decimalPlaces)) : "N/A"}
📈 **ROI**: ${signal.roi ? escapeMarkdown(signal.roi + "%") : "N/A"}
📈 **Outcome**: ${escapeMarkdown(signal.outcome || "Active")}

🕒 **Generated At**: ${escapeMarkdown(signal.createdAt || new Date().toLocaleString())}
🕒 **Closed At**: ${escapeMarkdown(signal.closedAt || "N/A")}
    `;

    try {
        await bot.sendMessage(chatId, message, { parse_mode: "MarkdownV2" });
        console.log(`[${new Date().toISOString()}] Message sent to Telegram:\n${message}`);
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Error sending Telegram message:`, error.message);
    }
}

async function sendActiveSignalStatus() {
    if (Object.keys(activeSignals).length === 0) {
        console.log("No active signals to send status update.");
        return;
    }

    let message = "📊 **Active Signal Status** 📊\n\n";

    for (const symbol in activeSignals) {
        const signal = activeSignals[symbol];

        // Fetch the latest price dynamically
        const latestPrice = await fetchLatestPrice(signal.crypto);
        const decimalPlaces = getDecimalPlaces(signal.crypto);

        if (latestPrice !== null) {
            console.log(`Current price of ${signal.crypto}: $${latestPrice}`);
        } else {
            console.error(`Failed to fetch the latest price for ${signal.crypto}`);
        }

        message += `
🔹 **Signal ID**: ${escapeMarkdown(signal.uniqueId || "N/A")}
🔹 **Crypto**: ${escapeMarkdown(signal.crypto || "N/A")}
🔹 **Signal Type**: ${escapeMarkdown(signal.signal || "N/A")}
🔹 **Entry Price**: $${signal.entryPrice ? escapeMarkdown(signal.entryPrice.toFixed(decimalPlaces)) : "N/A"}
🔹 **Current Price**: **$${latestPrice ? escapeMarkdown(latestPrice.toFixed(decimalPlaces)) : "N/A"}**
🔹 **Trailing Stop**: $${signal.trailingStop ? escapeMarkdown(signal.trailingStop.toFixed(decimalPlaces)) : "N/A"}
🔹 **Trailing Distance**: $${signal.trailingDistance ? escapeMarkdown(signal.trailingDistance.toFixed(decimalPlaces)) : "N/A"}
📈 **Outcome**: ${escapeMarkdown(signal.outcome || "Active")}
🕒 **Generated At**: ${escapeMarkdown(signal.createdAt || "N/A")}

`;
    }

    try {
        await bot.sendMessage(chatId, message, { parse_mode: "MarkdownV2" });
        console.log(`[${new Date().toISOString()}] Active signal status sent to Telegram.`);
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Error sending active signal status:`, error.message);
    }
}

// Periodically send active signal status every 10 minutes
setInterval(() => {
    sendActiveSignalStatus();
}, 10 * 60 * 1000);

// Start the bot
initializeBot();
