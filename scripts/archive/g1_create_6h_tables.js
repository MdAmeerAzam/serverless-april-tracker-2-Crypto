'use strict';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: 'postgresql://postgres.ybnpnpisvalswxyjjfvx:Qzh3nc8S%40UQezjc@aws-1-ap-northeast-1.pooler.supabase.com:6543/postgres?pgbouncer=true',
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
    query_timeout: 30000
});

async function run() {
    const client = await pool.connect();
    try {
        // Create base table
        await client.query(`
            CREATE TABLE IF NOT EXISTS btc_spot_6h (
                id TEXT PRIMARY KEY,
                timestamp BIGINT NOT NULL,
                open NUMERIC, high NUMERIC, low NUMERIC,
                closevalue NUMERIC, closepts NUMERIC, closepct NUMERIC, closevol NUMERIC,
                sar1 NUMERIC DEFAULT 0,
                sar2 NUMERIC DEFAULT 0,
                sar3 NUMERIC DEFAULT 0
            )
        `);
        console.log('[OK] btc_spot_6h created');

        // Clone structure for the other 3 tables
        await client.query('CREATE TABLE IF NOT EXISTS btc_futures_6h (LIKE btc_spot_6h INCLUDING ALL)');
        console.log('[OK] btc_futures_6h created');

        await client.query('CREATE TABLE IF NOT EXISTS eth_spot_6h (LIKE btc_spot_6h INCLUDING ALL)');
        console.log('[OK] eth_spot_6h created');

        await client.query('CREATE TABLE IF NOT EXISTS eth_futures_6h (LIKE btc_spot_6h INCLUDING ALL)');
        console.log('[OK] eth_futures_6h created');

        // Verify all 4 exist
        const res = await client.query(
            "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE '%6h' ORDER BY tablename"
        );
        console.log('\nVerified 6h tables now in Supabase:');
        res.rows.forEach(r => console.log('  ', r.tablename));

        // Also list all public tables to show current state
        const all = await client.query(
            "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename"
        );
        console.log('\nAll public tables:');
        all.rows.forEach(r => console.log('  ', r.tablename));

        console.log('\n[G1 COMPLETE] - All 4 six-hour tables created successfully');
    } finally {
        client.release();
        await pool.end();
    }
}

run().catch(e => {
    console.error('[FATAL]', e.message);
    pool.end();
    process.exit(1);
});
