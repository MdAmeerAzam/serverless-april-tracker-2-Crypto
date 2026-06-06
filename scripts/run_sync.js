process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { pool } = require('../api/db');
const { PSAR } = require('technicalindicators');
const { RestClientV5 } = require('bybit-api');

// Initialize the cryptographically signed client
const bybitClient = new RestClientV5({
    key: process.env.BYBIT_API_KEY,
    secret: process.env.BYBIT_API_SECRET,
    enable_time_sync: true,
});

const CRYPTO_ASSETS = [
    { asset: 'btc', market: 'spot',    symbol: 'BTCUSDT', category: 'spot' },
    { asset: 'btc', market: 'futures', symbol: 'BTCUSDT', category: 'linear' },
    { asset: 'eth', market: 'spot',    symbol: 'ETHUSDT', category: 'spot' },
    { asset: 'eth', market: 'futures', symbol: 'ETHUSDT', category: 'linear' },
];

const CRYPTO_INTERVALS = [
    { interval: '4h',      bybit: '240' },
    { interval: '12h',     bybit: '720' },
    { interval: 'daily',   bybit: 'D' },
    { interval: 'weekly',  bybit: 'W' },
    { interval: 'monthly', bybit: 'M' },
];

async function fetchBybit(category, symbol, interval, limit = 1000) {
    const response = await bybitClient.getKline({
        category: category,
        symbol: symbol,
        interval: interval,
        limit: limit
    });
    
    if (response.retCode !== 0) throw new Error('Bybit error: ' + response.retMsg);
    
    return response.result.list.reverse().map(p => ({
        timestamp: Number(p[0]),
        open: Number(p[1]),
        high: Number(p[2]),
        low: Number(p[3]),
        close: Number(p[4]),
        volume: Number(p[5])
    }));
}



async function processAndSave(tableName, klines) {
    if (klines.length < 3) return;

    const client = await pool.connect();
    try {
        const minTimestamp = klines[0].timestamp;
        const { rows: existing } = await client.query(
            `SELECT timestamp, sar1, sar2, sar3 FROM ${tableName} WHERE timestamp >= $1 ORDER BY timestamp ASC`,
            [minTimestamp]
        );
        const sarMap = new Map();
        existing.forEach(r => sarMap.set(Number(r.timestamp), r));

        const highs = klines.map(k => k.high);
        const lows  = klines.map(k => k.low);

        const sar1Results = new PSAR({ high: highs, low: lows, step: 0.02, max: 0.2 }).getResult();
        const off1 = klines.length - sar1Results.length;

        const formattedValues = [];
        for (let i = 0; i < klines.length; i++) {
            const k = klines[i];
            const isLive = (i === klines.length - 1);
            let s1 = 0, s2 = 0, s3 = 0;

            if (i >= off1) {
                const calc1 = Number(sar1Results[i - off1].toFixed(2));
                const ex = sarMap.get(k.timestamp);
                const calc2 = ex ? Number(ex.sar2) : 0;

                if (ex) {
                    const old1 = Number(ex.sar1);
                    s1 = old1 !== 0 ? old1 : calc1;
                    s2 = calc2;
                    if (isLive) {
                        s3 = (calc1 !== old1 && old1 !== 0) ? calc1 : 0;
                    } else {
                        // Zero-reset rule: if SAR3 = SAR1 on closed candle, collapse to 0
                        const frozen = Number(ex.sar3);
                        s3 = (frozen !== 0 && old1 !== 0 && frozen === old1) ? 0 : frozen;
                    }
                } else {
                    s1 = calc1;
                    s2 = calc2;
                    s3 = 0;
                }
            }

            const prevClose = i > 0 ? klines[i - 1].close : k.open;
            const pts = prevClose > 0 ? k.close - prevClose : 0;
            const pct = prevClose > 0 ? (pts / prevClose) * 100 : 0;

            formattedValues.push(`(${k.timestamp}, ${k.open}, ${k.high}, ${k.low}, ${k.close}, ${parseFloat(pts.toFixed(5))}, ${parseFloat(pct.toFixed(5))}, ${k.volume}, ${s1}, ${s2}, ${s3})`);
        }

        const chunkSize = 1000;
        for (let i = 0; i < formattedValues.length; i += chunkSize) {
            const chunk = formattedValues.slice(i, i + chunkSize);
            await client.query(`
                INSERT INTO ${tableName}
                (timestamp, open, high, low, closevalue, closepts, closepct, closevol, sar1, sar2, sar3)
                VALUES ${chunk.join(',')}
                ON CONFLICT (timestamp) DO UPDATE SET
                    open=EXCLUDED.open, high=EXCLUDED.high, low=EXCLUDED.low,
                    closevalue=EXCLUDED.closevalue, closepts=EXCLUDED.closepts,
                    closepct=EXCLUDED.closepct, closevol=EXCLUDED.closevol,
                    sar1=EXCLUDED.sar1, sar2=EXCLUDED.sar2, sar3=EXCLUDED.sar3
            `);
        }

        // Auto-heal dirty historical Zero-Reset violations
        await client.query(`UPDATE ${tableName} SET sar3 = 0 WHERE sar3 = sar1 AND sar1 != 0`);

        console.log(`  ✔ ${tableName}: ${klines.length} rows synced`);
    } catch (err) {
        throw err;
    } finally {
        client.release();
    }
}

(async () => {
    try {
        console.log('\n[GitHub Actions] Starting Sync Run...\n');

        // ── Crypto
        console.log('\n── Crypto (BTC + ETH spot/futures)');
        for (const asset of CRYPTO_ASSETS) {
            for (const tf of CRYPTO_INTERVALS) {
                const tableName = `${asset.asset}_${asset.market}_${tf.interval}`;
                process.stdout.write(`  → ${tableName}... `);
                try {
                    const klines = await fetchBybit(asset.category, asset.symbol, tf.bybit);
                    await processAndSave(tableName, klines);
                } catch (e) {
                    console.log(`  ✖ ${tableName}: ${e.message}`);
                }
            }
        }

        console.log('\n[Sync Complete]\n');
        process.exit(0);
    } catch (err) {
        console.error('FATAL SYNC ERROR:', err);
        process.exit(1);
    }
})();
