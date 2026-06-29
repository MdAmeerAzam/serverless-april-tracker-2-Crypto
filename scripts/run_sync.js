process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { pool } = require('../api/db');
const { PSAR } = require('technicalindicators');
const { RestClientV5 } = require('bybit-api');

const LOCK_TIMESTAMP_MS = 1749513599000; // June 9, 2025 23:59:59 UTC — never overwrite before this

const bybitClient = new RestClientV5({
    key: process.env.BYBIT_API_KEY,
    secret: process.env.BYBIT_API_SECRET,
    enable_time_sync: true,
});

const CRYPTO_ASSETS = [
    { asset: 'btc', market: 'spot',    symbol: 'BTCUSDT', category: 'spot'   },
    { asset: 'btc', market: 'futures', symbol: 'BTCUSDT', category: 'linear' },
    { asset: 'eth', market: 'spot',    symbol: 'ETHUSDT', category: 'spot'   },
    { asset: 'eth', market: 'futures', symbol: 'ETHUSDT', category: 'linear' },
];

const CRYPTO_INTERVALS = [
    { interval: '4h',      bybit: '240' },
    { interval: '6h',      bybit: '360' },
    { interval: '12h',     bybit: '720' },
    { interval: 'daily',   bybit: 'D'   },
    { interval: 'weekly',  bybit: 'W'   },
    { interval: 'monthly', bybit: 'M'   },
];

async function fetchBybit(category, symbol, interval, limit = 200) {
    const response = await bybitClient.getKline({ category, symbol, interval, limit });
    if (response.retCode !== 0) throw new Error('Bybit error: ' + response.retMsg);
    return response.result.list.reverse().map(p => ({
        timestamp: Number(p[0]), open: Number(p[1]), high: Number(p[2]),
        low: Number(p[3]), close: Number(p[4]), volume: Number(p[5])
    }));
}

async function processAndSave(tableName, klines) {
    if (klines.length < 3) return 0;

    const client = await pool.connect();
    try {
        const highs = klines.map(k => k.high);
        const lows  = klines.map(k => k.low);
        const sar1R = new PSAR({ high: highs, low: lows, step: 0.02, max: 0.2 }).getResult();
        const sar2R = new PSAR({ high: highs, low: lows, step: 0.01, max: 0.1 }).getResult();
        const off1  = klines.length - sar1R.length;
        const off2  = klines.length - sar2R.length;

        let prevS1 = 0;
        const rows = [];

        for (let i = 0; i < klines.length; i++) {
            const k = klines[i];
            let s1 = 0, s2 = 0, s3 = 0;

            if (i >= off1) {
                s1 = Number((sar1R[i - off1] || 0).toFixed(2));
                s2 = (i >= off2) ? Number((sar2R[i - off2] || 0).toFixed(2)) : 0;
                s3 = (prevS1 !== 0 && Math.abs(s1 - prevS1) > 0.000001) ? s1 : 0;
                prevS1 = s1;
            }

            const prevClose = i > 0 ? klines[i - 1].close : k.open;
            const pts = prevClose > 0 ? k.close - prevClose : 0;
            const pct = prevClose > 0 ? (pts / prevClose) * 100 : 0;

            if (k.timestamp > LOCK_TIMESTAMP_MS) {
                rows.push([String(k.timestamp), k.timestamp, k.open, k.high, k.low,
                    k.close, parseFloat(pts.toFixed(5)), parseFloat(pct.toFixed(5)),
                    k.volume, s1, s2, s3]);
            }
        }

        if (rows.length === 0) {
            process.stdout.write('no new candles beyond lock\n');
            return 0;
        }

        const CHUNK = 200;
        for (let i = 0; i < rows.length; i += CHUNK) {
            const chunk = rows.slice(i, i + CHUNK);
            const vals = chunk.map(r =>
                `('${r[0]}',${r[1]},${r[2]},${r[3]},${r[4]},${r[5]},${r[6]},${r[7]},${r[8]},${r[9]},${r[10]},${r[11]})`
            );
            await client.query(`
                INSERT INTO ${tableName}
                  (id,timestamp,open,high,low,closevalue,closepts,closepct,closevol,sar1,sar2,sar3)
                VALUES ${vals.join(',')}
                ON CONFLICT (id) DO UPDATE SET
                    open=EXCLUDED.open, high=EXCLUDED.high, low=EXCLUDED.low,
                    closevalue=EXCLUDED.closevalue, closepts=EXCLUDED.closepts,
                    closepct=EXCLUDED.closepct, closevol=EXCLUDED.closevol,
                    sar1=EXCLUDED.sar1, sar2=EXCLUDED.sar2, sar3=EXCLUDED.sar3
            `);
        }

        console.log(`${rows.length} upserted`);
        return rows.length;
    } finally {
        client.release();
    }
}

const { isSystemLocked } = require('../api/mutex');

(async () => {
    if (await isSystemLocked('MAINTENANCE_LOCK')) {
        console.log('[ABORT] Mutex active. Deferring.');
        process.exit(0);
    }
    try {
        console.log('\n[Crypto Sync] ' + new Date().toISOString());
        let total = 0;
        for (const asset of CRYPTO_ASSETS) {
            for (const tf of CRYPTO_INTERVALS) {
                const table = `${asset.asset}_${asset.market}_${tf.interval}`;
                process.stdout.write(`  → ${table}... `);
                try {
                    const klines = await fetchBybit(asset.category, asset.symbol, tf.bybit);
                    total += await processAndSave(table, klines);
                } catch (e) {
                    console.log(`FAIL: ${e.message}`);
                }
            }
        }
        console.log(`\n[Done] ${total} candles upserted\n`);
        process.exit(0);
    } catch (err) {
        console.error('FATAL:', err);
        process.exit(1);
    }
})();
