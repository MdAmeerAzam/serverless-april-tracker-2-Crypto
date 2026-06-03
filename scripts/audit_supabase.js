const { pool } = require('../api/db.js');

async function audit() {
    const client = await pool.connect();
    try {
        const { rows } = await client.query(`
            SELECT 
                current_database() as db_name,
                pg_size_pretty(pg_database_size(current_database())) as pretty_size,
                pg_database_size(current_database()) as raw_bytes
        `);
        console.log("==========================================");
        console.log(`[SUPABASE AUDIT] Database Name: ${rows[0].db_name}`);
        console.log(`[SUPABASE AUDIT] Raw Bytes: ${rows[0].raw_bytes}`);
        console.log(`[SUPABASE AUDIT] Pretty Size: ${rows[0].pretty_size}`);
        console.log("==========================================");
    } catch (e) {
        console.error("Audit failed:", e);
    } finally {
        client.release();
    }
    process.exit(0);
}
audit();
