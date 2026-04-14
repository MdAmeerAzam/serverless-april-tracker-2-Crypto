const { pool } = require('./api/db.js');

(async () => {
    let client;
    try {
        client = await pool.connect();
        console.log("Connected to Supabase Pooler natively.");
        const { rows } = await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public'`);
        console.log(`Discovered ${rows.length} existing tables.`);

        if(rows.length === 0) {
            console.log("ZERO TABLES EXIST! Creating 'klines' natively for test fallback...");
            await client.query(`
                CREATE TABLE IF NOT EXISTS klines (
                    id SERIAL PRIMARY KEY, timestamp BIGINT UNIQUE,
                    open REAL, high REAL, low REAL,
                    sar1 REAL, sar2 REAL, sar3 REAL,
                    closeValue REAL, closePts REAL, closePct REAL, closeVol REAL
                );
            `);
            console.log("klines fallback structured.");
        } else {
            for(let row of rows) {
                await client.query(`ALTER TABLE ${row.table_name} ADD COLUMN IF NOT EXISTS sar1 REAL;`);
                await client.query(`ALTER TABLE ${row.table_name} ADD COLUMN IF NOT EXISTS sar2 REAL;`);
                await client.query(`ALTER TABLE ${row.table_name} ADD COLUMN IF NOT EXISTS sar3 REAL;`);
            }
            console.log(`Successfully patched all ${rows.length} tables with SAR 3 geometric array targets.`);
        }
    } catch(err) {
        console.error("FATAL PATCH ERROR:", err);
    } finally {
        if(client) client.release();
        process.exit(0);
    }
})();
