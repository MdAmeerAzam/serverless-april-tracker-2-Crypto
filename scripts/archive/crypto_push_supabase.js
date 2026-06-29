'use strict';
/**
 * crypto_push_supabase.js — Step G5
 * Run AFTER crypto_verify_local.js confirms ALL PASS.
 * Run: node crypto_push_supabase.js
 *
 * Requires environment variable:
 *   DATABASE_URL=<your Supabase connection string>
 *
 * Run as:
 *   DATABASE_URL="postgres://..." node crypto_push_supabase.js
 *
 * OR create a .env.local file:
 *   DATABASE_URL=postgres://...
 *   Then: node -r dotenv/config crypto_push_supabase.js dotenv_config_path=.env.local
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { Pool }   = require('pg');
const Database   = require('better-sqlite3');
const fs         = require('fs');
const path       = require('path');

const DB_PATH      = path.resolve(__dirname, 'crypto_genesis.db');
const VERIFY_PATH  = path.resolve(__dirname, 'genesis_verify_report.json');

// ─── SAFETY CHECKS ───────────────────────────────────────────────────────────
if (!fs.existsSync(DB_PATH))     { console.error('[FATAL] crypto_genesis.db not found.'); process.exit(1); }
if (!fs.existsSync(VERIFY_PATH)) { console.error('[FATAL] genesis_verify_report.json not found. Run verify first.'); process.exit(1); }

const verifyReport = JSON.parse(fs.readFileSync(VERIFY_PATH, 'utf8'));
if (!verifyReport.allPassed) {
    console.error('[ABORT] genesis_verify_report.json shows failures. Fix them before pushing.');
    process.exit(1);
}

if (!process.env.DATABASE_URL) {
    console.error('[FATAL] DATABASE_URL environment variable not set.');
    console.error('  Usage: DATABASE_URL="postgres://..." node crypto_push_supabase.js');
    process.exit(1);
}

const TABLES = [
    'btc_spot_4h',      'btc_spot_6h',      'btc_spot_12h',
    'btc_spot_daily',   'btc_spot_weekly',   'btc_spot_monthly',
    'btc_futures_4h',   'btc_futures_6h',    'btc_futures_12h',
    'btc_futures_daily','btc_futures_weekly', 'btc_futures_monthly',
    'eth_spot_4h',      'eth_spot_6h',       'eth_spot_12h',
    'eth_spot_daily',   'eth_spot_weekly',   'eth_spot_monthly',
    'eth_futures_4h',   'eth_futures_6h',    'eth_futures_12h',
    'eth_futures_daily','eth_futures_weekly', 'eth_futures_monthly',
];

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const sqlite = new Database(DB_PATH, { readonly: true });

async function pushTable(client, tableName) {
    // Read ALL rows from SQLite for this table
    const rows = sqlite.prepare(`SELECT * FROM ${tableName} ORDER BY timestamp ASC`).all();
    if (rows.length === 0) {
        console.log(`  [SKIP] ${tableName}: 0 rows in SQLite`);
        return 0;
    }

    // Truncate Supabase table first (clean start)
    await client.query(`DELETE FROM ${tableName} WHERE 1=1`);

    // Batch insert in chunks of 200
    const CHUNK = 200;
    let inserted = 0;

    for (let i = 0; i < rows.length; i += CHUNK) {
        const chunk = rows.slice(i, i + CHUNK);

        const vals = chunk.map(r =>
            `('${r.id}', ${r.timestamp}, ${r.open}, ${r.high}, ${r.low}, ` +
            `${r.closevalue}, ${r.closepts}, ${r.closepct}, ${r.closevol}, ` +
            `${r.sar1}, ${r.sar2}, ${r.sar3})`
        );

        await client.query(`
            INSERT INTO ${tableName}
              (id, timestamp, open, high, low, closevalue, closepts, closepct, closevol, sar1, sar2, sar3)
            VALUES ${vals.join(',')}
            ON CONFLICT (id) DO NOTHING
        `);

        inserted += chunk.length;
    }

    return inserted;
}

async function main() {
    console.log('='.repeat(60));
    console.log('  CRYPTO → SUPABASE PUSH — Step G5');
    console.log(`  Tables: ${TABLES.length}`);
    console.log('  WARNING: This will DELETE and re-insert all data in Supabase.');
    console.log('='.repeat(60));

    const client = await pool.connect();
    const pushSummary = {};
    let totalPushed = 0, failures = 0;

    try {
        for (const table of TABLES) {
            process.stdout.write(`[${table}] ... `);
            try {
                const n = await pushTable(client, table);

                // Verify: count in Supabase must match SQLite
                const { rows: [{ count }] } = await client.query(`SELECT COUNT(*) as count FROM ${table}`);
                const sqliteCount = sqlite.prepare(`SELECT COUNT(*) as c FROM ${table}`).get().c;

                if (Number(count) === sqliteCount) {
                    console.log(`✔  ${n} rows pushed (Supabase: ${count} = SQLite: ${sqliteCount})`);
                    pushSummary[table] = { status: 'PASS', rows: n };
                    totalPushed += n;
                } else {
                    console.log(`✖  MISMATCH — Supabase: ${count}, SQLite: ${sqliteCount}`);
                    pushSummary[table] = { status: 'MISMATCH', supabase: count, sqlite: sqliteCount };
                    failures++;
                }
            } catch (err) {
                console.log(`✖  ERROR: ${err.message}`);
                pushSummary[table] = { status: 'ERROR', error: err.message };
                failures++;
            }
        }
    } finally {
        client.release();
        await pool.end();
        sqlite.close();
    }

    // Write push summary
    const summaryPath = path.resolve(__dirname, 'genesis_push_summary.json');
    fs.writeFileSync(summaryPath, JSON.stringify({ pushedAt: new Date().toISOString(), totalPushed, failures, tables: pushSummary }, null, 2));

    console.log('\n' + '='.repeat(60));
    if (failures === 0) {
        console.log(`  ✅ ALL ${TABLES.length} TABLES PUSHED SUCCESSFULLY`);
        console.log(`  Total rows in Supabase: ${totalPushed.toLocaleString()}`);
        console.log('  Historical data is LOCKED. Do not run genesis again.');
        console.log('  NEXT: Deploy new cloud-sync.yml and scripts (Phase C)');
    } else {
        console.log(`  ❌ ${failures} TABLES FAILED — Check genesis_push_summary.json`);
    }
    console.log('='.repeat(60));
    process.exit(failures > 0 ? 1 : 0);
}

main().catch(e => { console.error('[FATAL]', e); process.exit(1); });
