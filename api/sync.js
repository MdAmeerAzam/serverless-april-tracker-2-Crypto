const TradingView = require('@mathieuc/tradingview');
const { PSAR } = require('technicalindicators');
const { pool } = require('./db');

const TICKERS = {
    crypto: {
        btc: { spot: 'BINANCE:BTCUSDT', futures: 'BYBIT:BTCUSDT.P' },
        eth: { spot: 'BINANCE:ETHUSDT', futures: 'BYBIT:ETHUSDT.P' }
    },
    macro: {
        gold: { spot: 'OANDA:XAUUSD', futures: 'COMEX:GC1!' },
        silver: { spot: 'OANDA:XAGUSD', futures: 'COMEX:SI1!' },
        brent: { spot: 'TVC:UKOIL', futures: 'ICEEUR:BRN1!' },
        wti: { spot: 'TVC:USOIL', futures: 'NYMEX:CL1!' },
        natgas: { spot: 'OANDA:NATGASUSD', futures: 'NYMEX:NG1!' }
    }
};

const TIMEFRAMES = {
    '4h': '240',
    'daily': '1D',
    'weekly': '1W',
    'monthly': '1M'
};

// API Route: /api/sync?tracker=crypto&asset=btc&market=spot&interval=4h
module.exports = async (req, res) => {
    const { tracker, asset, market, interval } = req.query;

    if (!tracker || !asset || !market || !interval) {
        return res.status(400).json({ error: "Missing matrix parameters (tracker, asset, market, interval)." });
    }

    let tableName = `${asset}_${market}_${interval}`;
    
    // Legacy mapping exception for root Bitcoin tracking
    if (tracker === 'bitcoin' && asset === 'btc') {
        if (interval === '4h') tableName = 'klines';
        else tableName = `klines_${interval}`;
    }

    try {
        if (interval === '12h') {
            await synthesize12h(tableName, asset, market, tracker);
        } else {
            let mapTracker = tracker;
            if (tracker === 'bitcoin') mapTracker = 'crypto';
            
            if (mapTracker === 'crypto') {
                const bybitSymbol = asset.toUpperCase() + 'USDT';
                let bybitCategory = market === 'futures' ? 'linear' : 'spot';
                let bybitInterval = interval;
                if (interval === '4h') bybitInterval = '240';
                else if (interval === '12h') bybitInterval = '720';
                else if (interval === 'daily') bybitInterval = 'D';
                else if (interval === 'weekly') bybitInterval = 'W';
                else if (interval === 'monthly') bybitInterval = 'M';
                
                await extractBybit(tableName, bybitCategory, bybitSymbol, bybitInterval);
            } else {
                const rawTicker = TICKERS[mapTracker][asset][market];
                const tf = TIMEFRAMES[interval];
                await extractAndCalculate(tableName, rawTicker, tf);
            }
        }
        res.status(200).json({ success: true, message: `Micro-Transaction Sync successful for ${tableName}` });
    } catch (err) {
        console.error("Sync Failure:", err);
        res.status(500).json({ success: false, error: err.message });
    }
};

async function extractAndCalculate(tableName, ticker, timeframe) {
    return new Promise((resolve, reject) => {
        let executionHalted = false;
        const clientTV = new TradingView.Client();
        const chart = new clientTV.Session.Chart();
        chart.setMarket(ticker, { timeframe, range: 20000 }); 

        chart.onUpdate(() => {
            if (executionHalted) return; 
            if (!chart.periods || chart.periods.length < 50) return; 

            executionHalted = true; 
            const rawKlines = chart.periods.reverse().map(p => ({
                timestamp: p.time * 1000, 
                open: p.open,
                high: p.max,
                low: p.min,
                close: p.close,
                volume: p.volume || 0
            }));

            clientTV.end();
            processAndSaveDataPG(tableName, rawKlines).then(resolve).catch(reject);
        });

        // Hard timeout fallback just before Vercel 10s murder timeframe
        setTimeout(() => {
            if (!executionHalted) {
                executionHalted = true;
                clientTV.end();
                reject(new Error("Timeout pinging TradingView Socket for " + ticker));
            }
        }, 8000); 
    });
}

async function extractBybit(tableName, category, symbol, interval) {
    const url = `https://api.bybit.com/v5/market/kline?category=${category}&symbol=${symbol}&interval=${interval}&limit=200`;
    const response = await fetch(url);
    const data = await response.json();
    
    if (data.retCode !== 0) throw new Error("Bybit API Error: " + data.retMsg);
    
    const rawKlines = data.result.list.reverse().map(p => ({
        timestamp: Number(p[0]),
        open: Number(p[1]),
        high: Number(p[2]),
        low: Number(p[3]),
        close: Number(p[4]),
        volume: Number(p[5])
    }));
    
    await processAndSaveDataPG(tableName, rawKlines);
}

async function synthesize12h(tableName, asset, market, tracker) {
    let sourceTable = `${asset}_${market}_4h`;
    if (tracker === 'bitcoin' && asset === 'btc') sourceTable = 'klines';

    const client = await pool.connect();
    try {
        const { rows: rows4h } = await client.query(`SELECT * FROM ${sourceTable} ORDER BY timestamp ASC`);
        if (rows4h.length === 0) return;

        let chunk = [];
        const syntheticKlines = [];
        
        for (const row of rows4h) {
            chunk.push(row);
            if (chunk.length === 3) {
                syntheticKlines.push({
                    timestamp: chunk[0].timestamp,
                    open: chunk[0].open,
                    high: Math.max(...chunk.map(c => c.high)),
                    low: Math.min(...chunk.map(c => c.low)),
                    close: chunk[2].closeValue, 
                    volume: chunk.reduce((sum, c) => sum + Number(c.closeVol || 0), 0)
                });
                chunk = []; 
            }
        }
        await processAndSaveDataPG(tableName, syntheticKlines);
    } finally {
        client.release();
    }
}

async function processAndSaveDataPG(tableName, klines) {
    if (klines.length < 3) return;

    const client = await pool.connect();
    try {
        // Retrieve historical state to correctly construct SAR 1/2/3 Parity mapping
        const { rows: existingRows } = await client.query(`SELECT timestamp, sar1, sar2, sar3 FROM ${tableName} ORDER BY timestamp ASC`);
        const existingSarMap = new Map();
        existingRows.forEach(r => existingSarMap.set(Number(r.timestamp), r));

        const highList = klines.map(k => k.high);
        const lowList = klines.map(k => k.low);

        const sarResults = new PSAR({ high: highList, low: lowList, step: 0.02, max: 0.2 }).getResult();
        const sarResults2 = new PSAR({ high: highList, low: lowList, step: 0.01, max: 0.1 }).getResult();
        
        const sarOffset = klines.length - sarResults.length;
        const sarOffset2 = klines.length - sarResults2.length;

        await client.query("BEGIN");

        const insertQuery = `
            INSERT INTO ${tableName} 
            (timestamp, open, high, low, closeValue, closePts, closePct, closeVol, sar1, sar2, sar3) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            ON CONFLICT (timestamp) DO UPDATE SET
                open = EXCLUDED.open,
                high = EXCLUDED.high,
                low = EXCLUDED.low,
                closeValue = EXCLUDED.closeValue,
                closePts = EXCLUDED.closePts,
                closePct = EXCLUDED.closePct,
                closeVol = EXCLUDED.closeVol,
                sar1 = EXCLUDED.sar1,
                sar2 = EXCLUDED.sar2,
                sar3 = EXCLUDED.sar3
        `;

        for (let i = 0; i < klines.length; i++) {
            const kline = klines[i];
            const isLiveCandle = (i === klines.length - 1);
            let s1 = 0, s2 = 0, s3 = 0;

            if (i >= sarOffset) {
                const currentCalcSar = sarResults[i - sarOffset]; 
                const currentS2 = sarResults2[i - sarOffset2] ? sarResults2[i - sarOffset2] : 0;
                const existing = existingSarMap.get(kline.timestamp);

                if (existing) {
                    const oldHistoricalS1 = Number(existing.sar1);
                    const calculatedRounded = Number(currentCalcSar.toFixed(2));
                    
                    s1 = oldHistoricalS1 !== 0 ? oldHistoricalS1 : calculatedRounded; 
                    s2 = currentS2;
                    
                    if (isLiveCandle) {
                        if (calculatedRounded !== oldHistoricalS1 && oldHistoricalS1 !== 0) {
                            s3 = calculatedRounded; 
                        } else {
                            s3 = 0;
                        }
                    } else {
                        // Candle permanently closed — apply zero-reset rule:
                        // If SAR 3 = SAR 1, no divergence from genesis anchor → reset to 0
                        const frozenS3 = Number(existing.sar3);
                        s3 = (frozenS3 !== 0 && frozenS3 === Number(existing.sar1)) ? 0 : frozenS3;
                    }
                } else {
                    s1 = currentCalcSar;
                    s2 = currentS2 ? currentS2 : 0;
                    s3 = 0;
                }
            }

            let closePts = 0, closePct = 0;
            let prevClose = i > 0 ? klines[i - 1].close : kline.open;

            if (prevClose > 0) {
                closePts = kline.close - prevClose;
                closePct = (closePts / prevClose) * 100;
            }

            await client.query(insertQuery, [
                kline.timestamp, kline.open, kline.high, kline.low, kline.close,
                parseFloat(closePts.toFixed(5)), parseFloat(closePct.toFixed(5)), kline.volume,
                s1, s2, s3
            ]);
        }
        await client.query("COMMIT");
    } catch (err) {
        await client.query("ROLLBACK");
        throw err;
    } finally {
        client.release();
    }
}
