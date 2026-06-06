const { Pool } = require('pg');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const uri = "postgresql://postgres.ybnpnpisvalswxyjjfvx:Qzh3nc8S%40UQezjc@aws-1-ap-northeast-1.pooler.supabase.com:6543/postgres?pgbouncer=true";

const pool = new Pool({
    connectionString: uri,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000 // Increased timeout
});

async function main() {
    console.log("Connecting...");
    const start = Date.now();
    try {
        const client = await pool.connect();
        console.log(`Connected in ${Date.now() - start}ms`);
        const res = await client.query('SELECT NOW()');
        console.log("Time from DB:", res.rows[0].now);
        client.release();
    } catch (e) {
        console.error(`Failed after ${Date.now() - start}ms`, e);
    } finally {
        await pool.end();
    }
}
main();
