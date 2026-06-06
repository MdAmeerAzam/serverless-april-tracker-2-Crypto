const { pool } = require('../api/db.js');
const { PSAR } = require('technicalindicators');

const TABLES = [
    { name: 'btc_futures_4h', symbol: 'BTCUSDT', category: 'linear', interval: '240' },
    { name: 'btc_futures_daily', symbol: 'BTCUSDT', category: 'linear', interval: 'D' },
    { name: 'btc_futures_weekly', symbol: 'BTCUSDT', category: 'linear', interval: 'W' },
    { name: 'btc_futures_monthly', symbol: 'BTCUSDT', category: 'linear', interval: 'M' }
];

// 12h tables are synthetic, they will be handled separately by pulling from 4h tables
const SYNTHETIC_12H = [
    { name: 'btc_futures_12h', source: 'btc_futures_4h' }
];

async function fetchBybitHistory(symbol, category, interval, targetLimit = 1000) {
    console.log(`  Fetching ${targetLimit} candles for ${symbol} (${category}, ${interval})...`);
    const url = `https://api.bybit.com/v5/market/kline?category=${category}&symbol=${symbol}&interval=${interval}&limit=${targetLimit}`;
    const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const data = await response.json();
    if (data.retCode !== 0) throw new Error(`Bybit API Error: ${data.retMsg}`);
    
    return data.result.list.reverse().map(p => ({
        timestamp: Number(p[0]),
        open: Number(p[1]),
        high: Number(p[2]),
        low: Number(p[3]),
        close: Number(p[4]),
        volume: Number(p[5])
    }));
}

async function processAndSave(tableName, klines) {
    if (klines.length < 5) return;
    console.log(`  Processing ${klines.length} candles for ${tableName}...`);

    const highList = klines.map(k => k.high);
    const lowList = klines.map(k => k.low);

    const sarResults = new PSAR({ high: highList, low: lowList, step: 0.02, max: 0.2 }).getResult();
    const sarResults2 = new PSAR({ high: highList, low: lowList, step: 0.01, max: 0.1 }).getResult();

    const sarOffset = klines.length - sarResults.length;
    const sarOffset2 = klines.length - sarResults2.length;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(`TRUNCATE TABLE ${tableName} RESTART IDENTITY`);

        const insertQuery = `
            INSERT INTO ${tableName} 
            (timestamp, open, high, low, closeValue, closePts, closePct, closeVol, sar1, sar2, sar3) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        `;

        for (let i = 0; i < klines.length; i++) {
            const kline = klines[i];
            let s1 = 0, s2 = 0, s3 = 0;

            if (i >= sarOffset) {
                s1 = sarResults[i - sarOffset];
                s2 = sarResults2[i - sarOffset2] || 0;
                s3 = 0; // Fresh history has no live divergence s3
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
        await client.query('COMMIT');
        console.log(`  ✔ ${tableName} fully recovered.`);
    } catch (e) {
        await client.query('ROLLBACK');
        console.error(`  ✖ Failed ${tableName}:`, e.message);
    } finally {
        client.release();
    }
}

async function runRecovery() {
    console.log("[GENESIS RECOVERY] Initializing Full System Resync...");

    for (const table of TABLES) {
        try {
            const klines = await fetchBybitHistory(table.symbol, table.category, table.interval, 1000);
            await processAndSave(table.name, klines);
        } catch (e) {
            console.error(`  ✖ Error on ${table.name}:`, e.message);
        }
    }

    // Handle 12h syntheses
    console.log("[GENESIS RECOVERY] Constructing Synthetic 12h layers...");
    const client = await pool.connect();
    try {
        for (const target of SYNTHETIC_12H) {
            console.log(`  Synthesizing ${target.name} from ${target.source}...`);
            const { rows: rows4h } = await client.query(`SELECT * FROM ${target.source} ORDER BY timestamp ASC`);
            if (rows4h.length < 3) continue;

            const syntheticKlines = [];
            let chunk = [];
            for (const row of rows4h) {
                chunk.push(row);
                if (chunk.length === 3) {
                    syntheticKlines.push({
                        timestamp: Number(chunk[0].timestamp),
                        open: Number(chunk[0].open),
                        high: Math.max(...chunk.map(c => c.high)),
                        low: Math.min(...chunk.map(c => c.low)),
                        close: Number(chunk[2].closeValue),
                        volume: chunk.reduce((sum, c) => sum + Number(c.closeVol || 0), 0)
                    });
                    chunk = [];
                }
            }
            await processAndSave(target.name, syntheticKlines);
        }
    } finally {
        client.release();
    }

    console.log("[GENESIS RECOVERY] Operation Complete.");
    process.exit(0);
}

runRecovery();
