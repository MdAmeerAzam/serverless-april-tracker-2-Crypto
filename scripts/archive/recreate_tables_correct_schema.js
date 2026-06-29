'use strict';
// recreate_tables_correct_schema.js
// Drops and recreates 20 tables with id TEXT PRIMARY KEY (was INTEGER — broken)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: 'postgresql://postgres.ybnpnpisvalswxyjjfvx:Qzh3nc8S%40UQezjc@aws-1-ap-northeast-1.pooler.supabase.com:6543/postgres?pgbouncer=true',
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
    query_timeout: 60000
});

const TABLES_TO_FIX = [
    'btc_spot_4h',      'btc_spot_12h',       'btc_spot_daily',
    'btc_spot_weekly',  'btc_spot_monthly',
    'btc_futures_4h',   'btc_futures_12h',    'btc_futures_daily',
    'btc_futures_weekly','btc_futures_monthly',
    'eth_spot_4h',      'eth_spot_12h',        'eth_spot_daily',
    'eth_spot_weekly',  'eth_spot_monthly',
    'eth_futures_4h',   'eth_futures_12h',     'eth_futures_daily',
    'eth_futures_weekly','eth_futures_monthly',
];

const CORRECT_SCHEMA = (table) => `
    CREATE TABLE ${table} (
        id          TEXT PRIMARY KEY,
        timestamp   BIGINT NOT NULL,
        open        NUMERIC,
        high        NUMERIC,
        low         NUMERIC,
        closevalue  NUMERIC,
        closepts    NUMERIC,
        closepct    NUMERIC,
        closevol    NUMERIC,
        sar1        NUMERIC DEFAULT 0,
        sar2        NUMERIC DEFAULT 0,
        sar3        NUMERIC DEFAULT 0
    )
`;

async function main() {
    const client = await pool.connect();
    console.log('Connected. Fixing 20 tables: id INTEGER -> TEXT...\n');

    try {
        let fixed = 0, failed = 0;

        for (const table of TABLES_TO_FIX) {
            try {
                // Check current id type
                const res = await client.query(
                    `SELECT udt_name FROM information_schema.columns
                     WHERE table_name=$1 AND column_name='id' AND table_schema='public'`,
                    [table]
                );
                const idType = res.rows[0]?.udt_name;

                if (idType === 'text') {
                    console.log(`[SKIP] ${table}: id already TEXT`);
                    fixed++;
                    continue;
                }

                // Verify table is empty before dropping
                const countRes = await client.query(`SELECT COUNT(*) as c FROM ${table}`);
                const rowCount = Number(countRes.rows[0].c);

                if (rowCount > 0) {
                    console.log(`[WARN] ${table}: has ${rowCount} rows — skipping to avoid data loss`);
                    failed++;
                    continue;
                }

                // Drop and recreate with correct schema
                await client.query(`DROP TABLE IF EXISTS ${table}`);
                await client.query(CORRECT_SCHEMA(table));
                console.log(`[OK]   ${table}: dropped (id was ${idType}) and recreated with id TEXT`);
                fixed++;

            } catch (err) {
                console.error(`[FAIL] ${table}: ${err.message}`);
                failed++;
            }
        }

        // Final verification: check id type on all 20
        console.log('\n--- VERIFICATION ---');
        const verify = await client.query(
            `SELECT table_name, udt_name
             FROM information_schema.columns
             WHERE column_name='id' AND table_schema='public'
               AND table_name = ANY($1)
             ORDER BY table_name`,
            [TABLES_TO_FIX]
        );

        let allText = true;
        verify.rows.forEach(r => {
            const ok = r.udt_name === 'text';
            if (!ok) allText = false;
            console.log(`  ${ok ? '✔' : '✖'} ${r.table_name}: id = ${r.udt_name}`);
        });

        console.log(`\n${allText ? '✅ ALL 20 TABLES HAVE id TEXT — Safe to push' : '❌ Some tables still broken'}`);
        console.log(`Fixed: ${fixed} | Failed: ${failed}`);

    } finally {
        client.release();
        await pool.end();
    }
}

main().catch(e => { console.error('[FATAL]', e.message); pool.end(); process.exit(1); });
