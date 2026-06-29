process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { pool } = require('../api/db');
const { PSAR } = require('technicalindicators');
const { RestClientV5 } = require('bybit-api');

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

const HEALING_WINDOW = {
    '4h':     48,
    '12h':    20,
    'daily':  10,
    'weekly':  4,
    'monthly': 2
};

async function fetchBybit(category, symbol, interval, limit = 1000) {
    const response = await bybitClient.getKline({
        category, symbol, interval, limit
    });
    
    if (response.retCode !== 0) throw new Error('Bybit error: ' + response.retMsg);
    
    return response.result.list.reverse().map(p => ({
        timestamp: Number(p[0]),
        high: Number(p[2]),
        low: Number(p[3])
    }));
}

async function processSar2Genesis(tableName, klines, healingWindowFrames) {
    if (klines.length < 3) return;

    const highs = klines.map(k => k.high);
    const lows  = klines.map(k => k.low);

    // SAR 2 Parameters (Slow Macro)
    const sar2Results = new PSAR({ high: highs, low: lows, step: 0.01, max: 0.1 }).getResult();
    const sarOffset = klines.length - sar2Results.length;

    const liveIdx = klines.length - 1;
    const startIndex = Math.max(sarOffset, klines.length - healingWindowFrames);

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        let updateCount = 0;
        
        // Live candle
        if (liveIdx >= sarOffset) {
            const liveSar2 = Number(sar2Results[liveIdx - sarOffset].toFixed(2));
            await client.query(
                `UPDATE ${tableName} SET sar2 = $1 WHERE timestamp = $2`,
                [liveSar2, klines[liveIdx].timestamp]
            );
            updateCount++;
        }

        // Historical Backfill (Healing Window)
        for (let i = startIndex; i < liveIdx; i++) {
            if (i >= sarOffset) {
                const finalSar2 = Number(sar2Results[i - sarOffset].toFixed(2));
                await client.query(
                    `UPDATE ${tableName} SET sar2 = $1 WHERE timestamp = $2`,
                    [finalSar2, klines[i].timestamp]
                );
                updateCount++;
            }
        }

        await client.query('COMMIT');
        console.log(`  ✔ ${tableName}: ${updateCount} candles healed (SAR 2 Genesis)`);
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

(async () => {
    try {
        console.log('\n[GitHub Actions] Starting Hourly SAR 2 Genesis Run...\n');

        // ── Crypto
        console.log('\n── Crypto (BTC + ETH spot/futures)');
        for (const asset of CRYPTO_ASSETS) {
            for (const tf of CRYPTO_INTERVALS) {
                const tableName = `${asset.asset}_${asset.market}_${tf.interval}`;
                process.stdout.write(`  → ${tableName}... `);
                try {
                    const klines = await fetchBybit(asset.category, asset.symbol, tf.bybit);
                    const windowFrames = HEALING_WINDOW[tf.interval] || 20;
                    await processSar2Genesis(tableName, klines, windowFrames);
                } catch (e) {
                    console.log(`  ✖ ${tableName}: ${e.message}`);
                }
            }
        }

        console.log('\n[SAR 2 Genesis Complete]\n');
        process.exit(0);
    } catch (err) {
        console.error('FATAL SAR 2 GENESIS ERROR:', err);
        process.exit(1);
    }
})();
