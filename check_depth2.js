const { pool } = require('./api/db.js');
async function check() {
    const client = await pool.connect();
    const t1 = await client.query('SELECT MIN(timestamp) as min_ts FROM btc_spot_4h');
    const t2 = await client.query('SELECT MIN(timestamp) as min_ts FROM btc_spot_12h');
    const t3 = await client.query('SELECT MIN(timestamp) as min_ts FROM btc_futures_12h');
    const t4 = await client.query('SELECT MIN(timestamp) as min_ts FROM eth_spot_12h');
    
    console.log("Oldest btc_spot_4h:", new Date(Number(t1.rows[0].min_ts)).toISOString());
    console.log("Oldest btc_spot_12h:", new Date(Number(t2.rows[0].min_ts)).toISOString());
    console.log("Oldest btc_futures_12h:", new Date(Number(t3.rows[0].min_ts)).toISOString());
    console.log("Oldest eth_spot_12h:", new Date(Number(t4.rows[0].min_ts)).toISOString());
    process.exit(0);
}
check();
