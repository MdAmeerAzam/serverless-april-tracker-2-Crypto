const { pool } = require('../api/db.js');
const { PSAR } = require('technicalindicators');

const TARGETS = [
    { tableName: 'klines_12h', symbol: 'BTCUSDT', category: 'linear' },
    { tableName: 'btc_spot_12h', symbol: 'BTCUSDT', category: 'spot' },
    { tableName: 'btc_futures_12h', symbol: 'BTCUSDT', category: 'linear' },
    { tableName: 'eth_spot_12h', symbol: 'ETHUSDT', category: 'spot' },
    { tableName: 'eth_futures_12h', symbol: 'ETHUSDT', category: 'linear' },
];

async function fetchAllHistory(category, symbol, interval) {
    let allKlines = [];
    let endTime = Date.now();
    while (true) {
        const url = `https://api.bybit.com/v5/market/kline?category=${category}&symbol=${symbol}&interval=${interval}&limit=1000&end=${endTime}`;
        const res = await fetch(url);
        const data = await res.json();
        if (data.retCode !== 0 || !data.result.list || data.result.list.length === 0) break;
        
        const chunk = data.result.list.map(p => ({
            timestamp: Number(p[0]), open: Number(p[1]), high: Number(p[2]),
            low: Number(p[3]), close: Number(p[4]), volume: Number(p[5])
        }));
        
        allKlines.push(...chunk);
        endTime = chunk[chunk.length - 1].timestamp - 1;
        await new Promise(r => setTimeout(r, 200)); // Respect API limits
    }
    // Reverse to chronological order
    return allKlines.reverse();
}

async function genesis12h() {
    console.log("[GENESIS] Commencing 100% Historical 12H Data Reconstruction...");
    const client = await pool.connect();
    
    try {
        for (const t of TARGETS) {
            console.log(`  Processing ${t.tableName}...`);
            await client.query(`DELETE FROM ${t.tableName}`);
            console.log(`    Cleared old synthetic data.`);
            
            const klines = await fetchAllHistory(t.category, t.symbol, '720');
            console.log(`    Fetched ${klines.length} native 12H candles from Bybit.`);
            
            if (klines.length < 3) continue;

            const highs = klines.map(k => k.high);
            const lows  = klines.map(k => k.low);

            const sar1Results = new PSAR({ high: highs, low: lows, step: 0.02, max: 0.2 }).getResult();
            const sar2Results = new PSAR({ high: highs, low: lows, step: 0.01, max: 0.1 }).getResult();
            const off1 = klines.length - sar1Results.length;
            const off2 = klines.length - sar2Results.length;

            const insertQuery = `
                INSERT INTO ${t.tableName}
                (timestamp, open, high, low, closevalue, closepts, closepct, closevol, sar1, sar2, sar3)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
            `;

            await client.query('BEGIN');
            let prevS3 = 0, prevS1 = 0;

            for (let i = 0; i < klines.length; i++) {
                const k = klines[i];
                let s1 = 0, s2 = 0, s3 = 0;

                if (i >= off1) {
                    s1 = Number(sar1Results[i - off1].toFixed(2));
                    s2 = i >= off2 ? (sar2Results[i - off2] || 0) : 0;
                    if (prevS1 !== 0 && s1 !== prevS1) { s3 = s1; } else { s3 = prevS3; }
                    if (s3 !== 0 && prevS1 !== 0 && s3 === prevS1) s3 = 0;
                    prevS1 = s1;
                    prevS3 = s3;
                }

                const prevClose = i > 0 ? klines[i - 1].close : k.open;
                const pts = prevClose > 0 ? k.close - prevClose : 0;
                const pct = prevClose > 0 ? (pts / prevClose) * 100 : 0;

                await client.query(insertQuery, [
                    k.timestamp, k.open, k.high, k.low, k.close,
                    parseFloat(pts.toFixed(5)), parseFloat(pct.toFixed(5)), k.volume,
                    s1, s2, s3
                ]);
            }
            await client.query('COMMIT');
            console.log(`    ✔ Seeded 100% native history into DB.`);
        }
        console.log("[GENESIS COMPLETE] 12H Tables are fully reconstructed.");
        process.exit(0);
    } catch (e) {
        await client.query('ROLLBACK');
        console.error(e);
        process.exit(1);
    } finally {
        client.release();
    }
}
genesis12h();
