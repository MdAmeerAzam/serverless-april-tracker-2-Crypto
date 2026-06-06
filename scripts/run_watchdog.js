process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const { pool } = require('../api/db');

const TABLES = [
    { name: 'btc_spot_4h',      interval: 240   },
    { name: 'btc_spot_12h',     interval: 720   },
    { name: 'btc_spot_daily',   interval: 1440  },
    { name: 'btc_spot_weekly',  interval: 10080 },
    { name: 'btc_spot_monthly', interval: 43200 },
    // BTC Futures (4 timeframes)
    { name: 'btc_futures_4h',      interval: 240   },
    { name: 'btc_futures_12h',     interval: 720   },
    { name: 'btc_futures_daily',   interval: 1440  },
    { name: 'btc_futures_weekly',  interval: 10080 },
    { name: 'btc_futures_monthly', interval: 43200 },
    // ETH Spot (4 timeframes)
    { name: 'eth_spot_4h',      interval: 240   },
    { name: 'eth_spot_12h',     interval: 720   },
    { name: 'eth_spot_daily',   interval: 1440  },
    { name: 'eth_spot_weekly',  interval: 10080 },
    { name: 'eth_spot_monthly', interval: 43200 },
    // ETH Futures (4 timeframes)
    { name: 'eth_futures_4h',      interval: 240   },
    { name: 'eth_futures_12h',     interval: 720   },
    { name: 'eth_futures_daily',   interval: 1440  },
    { name: 'eth_futures_weekly',  interval: 10080 },
    { name: 'eth_futures_monthly', interval: 43200 },
];

async function checkTable(client, t) {
    const now = Date.now();
    const result = { name: t.name, status: 'OK', errors: [] };

    try {
        const { rows } = await client.query(`SELECT * FROM ${t.name} ORDER BY timestamp DESC LIMIT 7`);
        if (rows.length === 0) {
            result.status = 'FAIL';
            result.errors.push('Table is empty');
            return result;
        }

        const latest = rows[0];
        const gapMs = now - Number(latest.timestamp);
        const gapCandles = gapMs / (t.interval * 60 * 1000);

        // 1. Sync Gap Check (2 candle threshold)
        if (gapCandles > 2.2) {
            result.errors.push(`Sync Gap: Late by ${gapCandles.toFixed(1)} candles`);
        }

        let sar2Flatline = true;
        let sar1Missing = false;
        let zeroResetViolation = false;

        for (let i = 0; i < rows.length; i++) {
            const r = rows[i];
            const s1 = Number(Number(r.sar1).toFixed(2));
            const s2 = Number(r.sar2);
            const s3 = Number(Number(r.sar3).toFixed(2));
            const isClosed = (i > 0);

            if (s1 === 0) sar1Missing = true;
            if (s2 !== 0) sar2Flatline = false;

            // SAR 3 Zero-Reset Rule: on closed candles, if S3 == S1, it MUST be 0
            if (isClosed && s3 !== 0 && s1 !== 0 && s3 === s1) {
                zeroResetViolation = true;
            }
        }

        if (sar1Missing) result.errors.push('Genesis missing (SAR 1 = 0)');
        if (sar2Flatline) result.errors.push('Algorithm death (SAR 2 flatline)');
        if (zeroResetViolation) result.errors.push('Zero-Reset 3 violation (Dirty historical data)');

        if (result.errors.length > 0) result.status = 'ISSUE';

    } catch (e) {
        result.status = 'FAIL';
        result.errors.push(`Query Error: ${e.message}`);
    }

    return result;
}

(async () => {
    console.log('\n[Cloud Watchdog] Initializing Deep Perimeter Scan...');
    const client = await pool.connect();
    let totalIssues = 0;

    try {
        for (const t of TABLES) {
            const audit = await checkTable(client, t);
            if (audit.status !== 'OK') {
                totalIssues++;
                console.log(`\n✖ [${audit.name}] - ${audit.status}`);
                audit.errors.forEach(err => console.log(`  └─ ${err}`));
            } else {
                console.log(`✔ [${audit.name}] - Healthy`);
            }
        }

        if (totalIssues > 0) {
            console.log(`\n[CRITICAL] Watchdog detected ${totalIssues} anomalies. Triggering system failure alert.\n`);
            process.exit(1); // Fail the GitHub Action to trigger notification
        } else {
            console.log('\n[SUCCESS] Perimeter is mathematically secure. No anomalies detected.\n');
            process.exit(0);
        }
    } finally {
        client.release();
    }
})();
