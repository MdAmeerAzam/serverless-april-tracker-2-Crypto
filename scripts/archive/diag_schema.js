'use strict';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const { Pool } = require('pg');
const pool = new Pool({
    connectionString: 'postgresql://postgres.ybnpnpisvalswxyjjfvx:Qzh3nc8S%40UQezjc@aws-1-ap-northeast-1.pooler.supabase.com:6543/postgres?pgbouncer=true',
    ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000, query_timeout: 30000
});

async function main() {
    const client = await pool.connect();
    try {
        // 1. Get schema for btc_spot_4h
        const schema = await client.query(
            `SELECT column_name, data_type, udt_name
             FROM information_schema.columns
             WHERE table_name = 'btc_spot_4h' AND table_schema = 'public'
             ORDER BY ordinal_position`
        );
        console.log('btc_spot_4h column types:');
        schema.rows.forEach(r => console.log(`  ${r.column_name}: ${r.data_type} (${r.udt_name})`));

        // 2. Try inserting one test row with ms timestamp as TEXT id
        const testTs = 1625486400000;
        try {
            await client.query(
                `INSERT INTO btc_spot_4h (id, timestamp, open, high, low, closevalue, closepts, closepct, closevol, sar1, sar2, sar3)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                 ON CONFLICT (id) DO NOTHING`,
                [String(testTs), testTs, 1.0, 2.0, 0.9, 1.5, 0.5, 0.01, 100.0, 1.1, 1.0, 1.1]
            );
            console.log('\n[OK] Parameterized insert succeeded');
        } catch(e) {
            console.log('\n[FAIL] Parameterized insert:', e.message);
        }

        // 3. Check if id column is numeric
        const idType = schema.rows.find(r => r.column_name === 'id');
        console.log('\nid column type:', idType?.udt_name);

        // 4. Check existing row in table
        const sample = await client.query('SELECT id, timestamp FROM btc_spot_4h LIMIT 3');
        console.log('Sample rows:', sample.rows);

    } finally {
        client.release();
        await pool.end();
    }
}
main().catch(e => { console.error('[FATAL]', e.message); pool.end(); process.exit(1); });
