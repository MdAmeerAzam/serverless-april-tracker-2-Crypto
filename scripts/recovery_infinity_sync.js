const { pool } = require('../api/db.js');
const { PSAR } = require('technicalindicators');

const TABLES = [
    { name: 'btc_futures_4h', symbol: 'BTCUSDT', category: 'linear', interval: '240' },
    { name: 'btc_futures_8h', symbol: 'BTCUSDT', category: 'linear', interval: '480' },
    { name: 'btc_futures_daily', symbol: 'BTCUSDT', category: 'linear', interval: 'D' },
    { name: 'btc_futures_weekly', symbol: 'BTCUSDT', category: 'linear', interval: 'W' },
    { name: 'btc_futures_monthly', symbol: 'BTCUSDT', category: 'linear', interval: 'M' }
];

const SYNTHETIC_12H = [
    { name: 'btc_futures_12h', source: 'btc_futures_4h' }
];

async function fetchBybitInfinity(symbol, category, interval) {
    let allKlines = [];
    let lastTimestamp = Date.now();
    let hasMore = true;

    console.log(`  [INFINITY FETCH] Starting recursive crawl for ${symbol} ${interval}...`);

    while (hasMore) {
        const url = `https://api.bybit.com/v5/market/kline?category=${category}&symbol=${symbol}&interval=${interval}&limit=1000&end=${lastTimestamp}`;
        const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const data = await response.json();

        if (data.retCode !== 0 || !data.result.list || data.result.list.length === 0) {
            hasMore = false;
            break;
        }

        const batch = data.result.list.map(p => ({
            timestamp: Number(p[0]),
            open: Number(p[1]),
            high: Number(p[2]),
            low: Number(p[3]),
            close: Number(p[4]),
            volume: Number(p[5])
        }));

        allKlines = [...batch, ...allKlines];
        
        // Step back to the millisecond BEFORE the oldest candle in this batch
        lastTimestamp = batch[batch.length - 1].timestamp - 1; 
        
        console.log(`    Captured ${allKlines.length} rows... (Archive reached: ${new Date(batch[batch.length - 1].timestamp).toISOString()})`);
        
        // Stop if we got fewer than 1000 candles (reached the beginning of Bybit history)
        if (data.result.list.length < 1000) {
            hasMore = false;
            break;
        }

        // Safety cap (50,000 candles is massive history)
        if (allKlines.length > 50000) break; 
        
        // Rate limit protection
        await new Promise(r => setTimeout(r, 100));
    }

    // Deduplicate just in case of API quirk
    const uniqueMap = new Map();
    allKlines.forEach(k => uniqueMap.set(k.timestamp, k));
    const finalKlines = Array.from(uniqueMap.values()).sort((a, b) => a.timestamp - b.timestamp);
    
    return finalKlines;
}

async function processAndSave(tableName, klines) {
    if (klines.length < 5) return;
    console.log(`  [INGESTION] Pushing ${klines.length} genesis rows to ${tableName} (Optimized Batch)...`);

    const highList = klines.map(k => k.high);
    const lowList = klines.map(k => k.low);

    const sarResults = new PSAR({ high: highList, low: lowList, step: 0.02, max: 0.2 }).getResult();
    const sarResults2 = new PSAR({ high: highList, low: lowList, step: 0.01, max: 0.1 }).getResult();

    const sarOffset = klines.length - sarResults.length;
    const sarOffset2 = klines.length - sarResults2.length;

    const dataRows = [];
    for (let i = 0; i < klines.length; i++) {
        const kline = klines[i];
        let s1 = 0, s2 = 0;
        if (i >= sarOffset) s1 = sarResults[i - sarOffset];
        if (i >= sarOffset2) s2 = sarResults2[i - sarOffset2] || 0;

        let closePts = 0, closePct = 0;
        let prevClose = i > 0 ? klines[i - 1].close : kline.open;
        if (prevClose > 0) {
            closePts = kline.close - prevClose;
            closePct = (closePts / prevClose) * 100;
        }

        dataRows.push([
            kline.timestamp, kline.open, kline.high, kline.low, kline.close,
            parseFloat(closePts.toFixed(5)), parseFloat(closePct.toFixed(5)), kline.volume,
            s1, s2, 0
        ]);
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(`TRUNCATE TABLE ${tableName} RESTART IDENTITY`);

        // Batch insertion logic (100 rows per query)
        const chunkSize = 100;
        for (let i = 0; i < dataRows.length; i += chunkSize) {
            const chunk = dataRows.slice(i, i + chunkSize);
            const values = [];
            const placeholders = [];
            
            chunk.forEach((row, rowIndex) => {
                const rowOffset = rowIndex * 11;
                const rowPlaceholders = [];
                row.forEach((_, colIndex) => {
                    rowPlaceholders.push(`$${rowOffset + colIndex + 1}`);
                    values.push(row[colIndex]);
                });
                placeholders.push(`(${rowPlaceholders.join(',')})`);
            });

            const query = `INSERT INTO ${tableName} (timestamp, open, high, low, closeValue, closePts, closePct, closeVol, sar1, sar2, sar3) VALUES ${placeholders.join(',')}`;
            await client.query(query, values);
        }

        await client.query('COMMIT');
        console.log(`  ✔ ${tableName} Recovery Synchronized.`);
    } catch (e) {
        await client.query('ROLLBACK');
        console.error(`  ✖ Failed ${tableName}:`, e.message);
    } finally {
        client.release();
    }
}

async function runInfinity() {
    console.log("[INIFINITY RECOVERY] Operation Commenced: Building 12-Table Genesis Archive...");

    for (const table of TABLES) {
        try {
            const klines = await fetchBybitInfinity(table.symbol, table.category, table.interval);
            await processAndSave(table.name, klines);
        } catch (e) {
            console.error(`  ✖ Critical Failure on ${table.name}:`, e.message);
        }
    }

    const SYNTHETIC_LAYERS = [
        { name: 'btc_futures_12h', source: 'btc_futures_4h', multiplier: 3 },
        { name: 'btc_futures_8h', source: 'btc_futures_4h', multiplier: 2 }
    ];

    console.log("[INFINITY RECOVERY] Synthesizing Multi-Tf Layers (8h & 12h)...");
    const client = await pool.connect();
    try {
        for (const target of SYNTHETIC_LAYERS) {
            console.log(`  Synthesizing ${target.name} from ${target.source} (x${target.multiplier})...`);
            const { rows: rows4h } = await client.query(`SELECT * FROM ${target.source} ORDER BY timestamp ASC`);
            if (rows4h.length < target.multiplier) continue;

            const syntheticKlines = [];
            let chunk = [];
            for (const row of rows4h) {
                chunk.push(row);
                if (chunk.length === target.multiplier) {
                    syntheticKlines.push({
                        timestamp: Number(chunk[0].timestamp),
                        open: Number(chunk[0].open),
                        high: Math.max(...chunk.map(c => c.high)),
                        low: Math.min(...chunk.map(c => c.low)),
                        close: Number(chunk[chunk.length - 1].closevalue),
                        volume: chunk.reduce((sum, c) => sum + Number(c.closevol || 0), 0)
                    });
                    chunk = [];
                }
            }
            await processAndSave(target.name, syntheticKlines);
        }
    } finally {
        client.release();
    }

    console.log("[INFINITY RECOVERY] All-Time Genesis Reconstruction Complete.");
    process.exit(0);
}

runInfinity();
