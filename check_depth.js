const { pool } = require('./api/db.js');
async function check() {
    const client = await pool.connect();
    const t1 = await client.query('SELECT MIN(timestamp) as min_ts FROM klines');
    const t2 = await client.query('SELECT MIN(timestamp) as min_ts FROM klines_daily');
    const t3 = await client.query('SELECT MIN(timestamp) as min_ts FROM btc_spot_daily');
    console.log("Oldest klines (4H):", new Date(Number(t1.rows[0].min_ts)).toISOString());
    console.log("Oldest klines_daily:", new Date(Number(t2.rows[0].min_ts)).toISOString());
    console.log("Oldest btc_spot_daily:", new Date(Number(t3.rows[0].min_ts)).toISOString());
    process.exit(0);
}
check();
