const { pool } = require('../api/db.js');
const { PSAR } = require('technicalindicators');

const TARGETS = [
    // Standalone Bitcoin Matrix
    { tableName: 'klines',         symbol: 'BTCUSDT', category: 'linear', interval: '240' },
    { tableName: 'klines_daily',   symbol: 'BTCUSDT', category: 'linear', interval: 'D' },
    { tableName: 'klines_weekly',  symbol: 'BTCUSDT', category: 'linear', interval: 'W' },
    { tableName: 'klines_monthly', symbol: 'BTCUSDT', category: 'linear', interval: 'M' },

    // BTC Spot Matrix
    { tableName: 'btc_spot_4h',      symbol: 'BTCUSDT', category: 'spot',   interval: '240' },
    { tableName: 'btc_spot_daily',   symbol: 'BTCUSDT', category: 'spot',   interval: 'D' },
    { tableName: 'btc_spot_weekly',  symbol: 'BTCUSDT', category: 'spot',   interval: 'W' },
    { tableName: 'btc_spot_monthly', symbol: 'BTCUSDT', category: 'spot',   interval: 'M' },

    // BTC Futures Matrix
    { tableName: 'btc_futures_4h',      symbol: 'BTCUSDT', category: 'linear', interval: '240' },
    { tableName: 'btc_futures_daily',   symbol: 'BTCUSDT', category: 'linear', interval: 'D' },
    { tableName: 'btc_futures_weekly',  symbol: 'BTCUSDT', category: 'linear', interval: 'W' },
    { tableName: 'btc_futures_monthly', symbol: 'BTCUSDT', category: 'linear', interval: 'M' },

    // ETH Spot Matrix
    { tableName: 'eth_spot_4h',      symbol: 'ETHUSDT', category: 'spot',   interval: '240' },
    { tableName: 'eth_spot_daily',   symbol: 'ETHUSDT', category: 'spot',   interval: 'D' },
    { tableName: 'eth_spot_weekly',  symbol: 'ETHUSDT', category: 'spot',   interval: 'W' },
    { tableName: 'eth_spot_monthly', symbol: 'ETHUSDT', category: 'spot',   interval: 'M' },

    // ETH Futures Matrix
    { tableName: 'eth_futures_4h',      symbol: 'ETHUSDT', category: 'linear', interval: '240' },
    { tableName: 'eth_futures_daily',   symbol: 'ETHUSDT', category: 'linear', interval: 'D' },
    { tableName: 'eth_futures_weekly',  symbol: 'ETHUSDT', category: 'linear', interval: 'W' },
    { tableName: 'eth_futures_monthly', symbol: 'ETHUSDT', category: 'linear', interval: 'M' }
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
        await new Promise(r => setTimeout(r, 200)); 
    }
    return allKlines.reverse();
}

async function runGlobalGenesis() {
    console.log("[GLOBAL GENESIS] Commencing 100% Historical Data Reconstruction...");
    const client = await pool.connect();
    
    try {
        for (const t of TARGETS) {
            console.log(`  Processing ${t.tableName}...`);
            await client.query(`DELETE FROM ${t.tableName}`);
            
            const klines = await fetchAllHistory(t.category, t.symbol, t.interval);
            console.log(`    Fetched ${klines.length} native candles from Bybit Inception.`);
            
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
        console.log("[GLOBAL GENESIS COMPLETE] Entire Cloud Crypto DB is 100% Historical.");
        process.exit(0);
    } catch (e) {
        await client.query('ROLLBACK');
        console.error(e);
        process.exit(1);
    } finally {
        client.release();
    }
}
runGlobalGenesis();
