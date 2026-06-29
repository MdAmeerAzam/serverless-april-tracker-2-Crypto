'use strict';
/**
 * crypto_genesis_local.js — Step G2
 * Run: node crypto_genesis_local.js
 * Install first: npm install bybit-api technicalindicators better-sqlite3
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { RestClientV5 } = require('bybit-api');
const { PSAR }          = require('technicalindicators');
const Database          = require('better-sqlite3');
const fs                = require('fs');
const path              = require('path');

const LOCK_TIMESTAMP_MS = 1749513599000; // June 9, 2026 23:59:59 UTC

const bybitClient = new RestClientV5({});

const ASSETS = [
    { asset: 'btc', market: 'spot',    symbol: 'BTCUSDT', category: 'spot'   },
    { asset: 'btc', market: 'futures', symbol: 'BTCUSDT', category: 'linear' },
    { asset: 'eth', market: 'spot',    symbol: 'ETHUSDT', category: 'spot'   },
    { asset: 'eth', market: 'futures', symbol: 'ETHUSDT', category: 'linear' },
];

const INTERVALS = [
    { label: '4h',      bybit: '240', ms: 4  * 60 * 60 * 1000 },
    { label: '6h',      bybit: '360', ms: 6  * 60 * 60 * 1000 },
    { label: '12h',     bybit: '720', ms: 12 * 60 * 60 * 1000 },
    { label: 'daily',   bybit: 'D',   ms: 24 * 60 * 60 * 1000 },
    { label: 'weekly',  bybit: 'W',   ms: 7  * 24 * 60 * 60 * 1000 },
    { label: 'monthly', bybit: 'M',   ms: 30 * 24 * 60 * 60 * 1000 },
];

const DB_PATH = path.resolve(__dirname, 'crypto_genesis.db');
const db = new Database(DB_PATH);

function initTable(tableName) {
    db.prepare(`
        CREATE TABLE IF NOT EXISTS ${tableName} (
            id TEXT PRIMARY KEY, timestamp INTEGER NOT NULL,
            open REAL, high REAL, low REAL,
            closevalue REAL, closepts REAL, closepct REAL, closevol REAL,
            sar1 REAL DEFAULT 0, sar2 REAL DEFAULT 0, sar3 REAL DEFAULT 0
        )
    `).run();
}

async function fetchAllBybit(category, symbol, bybitInterval) {
    const allCandles = [];
    let endTime = LOCK_TIMESTAMP_MS + 1;

    while (true) {
        let response;
        try {
            response = await bybitClient.getKline({ category, symbol, interval: bybitInterval, limit: 1000, end: String(endTime) });
        } catch (err) {
            console.error(`    [RETRY] ${err.message}`);
            await sleep(2000);
            continue;
        }

        if (response.retCode !== 0) throw new Error(`Bybit: ${response.retMsg}`);

        const batch = response.result?.list;
        if (!batch || batch.length === 0) break;

        const parsed = batch
            .map(p => ({ timestamp: Number(p[0]), open: Number(p[1]), high: Number(p[2]), low: Number(p[3]), close: Number(p[4]), volume: Number(p[5]) }))
            .filter(c => c.timestamp <= LOCK_TIMESTAMP_MS);

        allCandles.push(...parsed);

        const oldest = Math.min(...batch.map(p => Number(p[0])));
        endTime = oldest - 1;

        console.log(`    fetched ${allCandles.length} (oldest: ${new Date(oldest).toISOString().slice(0,10)})`);
        await sleep(300);

        if (batch.length < 1000) break;
    }

    allCandles.sort((a, b) => a.timestamp - b.timestamp);
    return allCandles;
}

function calculateSAR(candles) {
    if (candles.length < 3) return [];
    const highs = candles.map(c => c.high);
    const lows  = candles.map(c => c.low);
    const sar1R = new PSAR({ high: highs, low: lows, step: 0.02, max: 0.2 }).getResult();
    const sar2R = new PSAR({ high: highs, low: lows, step: 0.01, max: 0.1 }).getResult();
    const o1 = candles.length - sar1R.length;
    const o2 = candles.length - sar2R.length;
    let prevS1 = 0;
    return candles.map((c, i) => {
        let s1 = 0, s2 = 0, s3 = 0;
        if (i >= o1) {
            s1 = sar1R[i - o1] || 0;
            s2 = (i >= o2) ? (sar2R[i - o2] || 0) : 0;
            // SAR3: non-zero ONLY on candles where SAR1 changes value; 0 otherwise
            s3 = (prevS1 !== 0 && Math.abs(s1 - prevS1) > 0.000001) ? s1 : 0;
            prevS1 = s1;
        }
        const prevClose = i > 0 ? candles[i-1].close : c.open;
        const closePts  = prevClose > 0 ? c.close - prevClose : 0;
        const closePct  = prevClose > 0 ? (closePts / prevClose) * 100 : 0;
        return { id: String(c.timestamp), timestamp: c.timestamp, open: c.open, high: c.high, low: c.low, closevalue: c.close, closepts: closePts, closepct: closePct, closevol: c.volume, sar1: s1, sar2: s2, sar3: s3 };
    });
}

function insertRows(tableName, rows) {
    const ins = db.prepare(`INSERT OR REPLACE INTO ${tableName} (id,timestamp,open,high,low,closevalue,closepts,closepct,closevol,sar1,sar2,sar3) VALUES (@id,@timestamp,@open,@high,@low,@closevalue,@closepts,@closepct,@closevol,@sar1,@sar2,@sar3)`);
    const tx = db.transaction(chunk => { for (const r of chunk) ins.run(r); });
    for (let i = 0; i < rows.length; i += 500) tx(rows.slice(i, i + 500));
}

function detectGaps(candles, intervalMs) {
    const gaps = [];
    for (let i = 1; i < candles.length; i++) {
        const gap = candles[i].timestamp - candles[i-1].timestamp;
        if (gap > intervalMs * 1.5) gaps.push({ after: new Date(candles[i-1].timestamp).toISOString(), before: new Date(candles[i].timestamp).toISOString(), gapHours: (gap / 3600000).toFixed(1) });
    }
    return gaps;
}

async function main() {
    console.log('='.repeat(60));
    console.log('  CRYPTO GENESIS ENGINE — Repo 2 (Bybit)');
    console.log(`  Lock: ${new Date(LOCK_TIMESTAMP_MS).toISOString()}`);
    console.log('='.repeat(60));

    const report = { generatedAt: new Date().toISOString(), lockBoundary: new Date(LOCK_TIMESTAMP_MS).toISOString(), tables: {}, totalRows: 0, passCount: 0, failCount: 0 };

    for (const asset of ASSETS) {
        for (const tf of INTERVALS) {
            const table = `${asset.asset}_${asset.market}_${tf.label}`;
            console.log(`\n[${table}]`);
            initTable(table);
            try {
                const candles = await fetchAllBybit(asset.category, asset.symbol, tf.bybit);
                if (candles.length === 0) { console.log('  WARN: zero candles'); report.tables[table] = { status: 'WARN_EMPTY', rows: 0 }; report.failCount++; continue; }
                const rows  = calculateSAR(candles);
                const gaps  = detectGaps(candles, tf.ms);
                insertRows(table, rows);
                const cnt   = db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get().c;
                const first = db.prepare(`SELECT MIN(timestamp) as t FROM ${table}`).get().t;
                const last  = db.prepare(`SELECT MAX(timestamp) as t FROM ${table}`).get().t;
                const z0    = db.prepare(`SELECT COUNT(*) as c FROM ${table} WHERE sar1 = 0`).get().c;
                const status = (cnt === rows.length) ? 'PASS' : 'FAIL';
                report.tables[table] = { status, rows: cnt, firstCandle: new Date(first).toISOString(), lastCandle: new Date(last).toISOString(), gapCount: gaps.length, gaps: gaps.slice(0,5), sar1ZeroRows: z0 };
                report.totalRows += cnt;
                status === 'PASS' ? report.passCount++ : report.failCount++;
                console.log(`  [${status}] ${cnt} rows | ${gaps.length} gaps | sar1_zero: ${z0}`);
            } catch (err) {
                console.error(`  [FAIL] ${err.message}`);
                report.tables[table] = { status: 'FAIL', error: err.message, rows: 0 };
                report.failCount++;
            }
            await sleep(500);
        }
    }

    const reportPath = path.resolve(__dirname, 'genesis_audit_report.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

    console.log('\n' + '='.repeat(60));
    console.log(`  DONE: ${report.passCount} PASS  ${report.failCount} WARN/FAIL`);
    console.log(`  Total rows: ${report.totalRows.toLocaleString()}`);
    console.log(`  Report: ${reportPath}`);
    console.log('='.repeat(60));
    console.log('NEXT: node crypto_verify_local.js');
    db.close();
    process.exit(0);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
main().catch(e => { console.error('[FATAL]', e); process.exit(1); });
