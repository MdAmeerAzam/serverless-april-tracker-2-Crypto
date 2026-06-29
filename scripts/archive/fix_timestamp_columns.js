'use strict';
// fix_timestamp_columns.js — alter 20 tables: INTEGER -> BIGINT for timestamp
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: 'postgresql://postgres.ybnpnpisvalswxyjjfvx:Qzh3nc8S%40UQezjc@aws-1-ap-northeast-1.pooler.supabase.com:6543/postgres?pgbouncer=true',
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
    query_timeout: 60000
});

// The 20 tables that failed due to INTEGER overflow
const FAILED_TABLES = [
    'btc_spot_4h',      'btc_spot_12h',      'btc_spot_daily',
    'btc_spot_weekly',  'btc_spot_monthly',
    'btc_futures_4h',   'btc_futures_12h',   'btc_futures_daily',
    'btc_futures_weekly','btc_futures_monthly',
    'eth_spot_4h',      'eth_spot_12h',       'eth_spot_daily',
    'eth_spot_weekly',  'eth_spot_monthly',
    'eth_futures_4h',   'eth_futures_12h',    'eth_futures_daily',
    'eth_futures_weekly','eth_futures_monthly',
];

async function main() {
    const client = await pool.connect();
    console.log('Connected. Altering timestamp columns INTEGER -> BIGINT...\n');

    try {
        for (const table of FAILED_TABLES) {
            try {
                // Check current type first
                const typeCheck = await client.query(
                    `SELECT data_type FROM information_schema.columns
                     WHERE table_name = $1 AND column_name = 'timestamp' AND table_schema = 'public'`,
                    [table]
                );
                const currentType = typeCheck.rows[0]?.data_type;

                if (currentType === 'bigint') {
                    console.log(`[SKIP] ${table}: already BIGINT`);
                    continue;
                }

                // First clear the table (it has corrupted/old data anyway)
                await client.query(`DELETE FROM ${table} WHERE 1=1`);

                // ALTER to BIGINT
                await client.query(`ALTER TABLE ${table} ALTER COLUMN timestamp TYPE BIGINT`);
                console.log(`[OK]   ${table}: INTEGER -> BIGINT (${currentType || 'unknown'} -> bigint)`);
            } catch (err) {
                console.error(`[FAIL] ${table}: ${err.message}`);
            }
        }

        // Verify all tables now have BIGINT
        console.log('\nVerification:');
        const res = await client.query(
            `SELECT table_name, data_type
             FROM information_schema.columns
             WHERE column_name = 'timestamp'
               AND table_schema = 'public'
               AND table_name = ANY($1)
             ORDER BY table_name`,
            [FAILED_TABLES]
        );
        let allBigint = true;
        res.rows.forEach(r => {
            const ok = r.data_type === 'bigint';
            if (!ok) allBigint = false;
            console.log(`  ${ok ? '✔' : '✖'} ${r.table_name}: ${r.data_type}`);
        });

        console.log(`\n${allBigint ? '✅ ALL COLUMNS NOW BIGINT — Ready to push' : '❌ Some columns still not BIGINT'}`);
    } finally {
        client.release();
        await pool.end();
    }
}

main().catch(e => { console.error('[FATAL]', e.message); pool.end(); process.exit(1); });
