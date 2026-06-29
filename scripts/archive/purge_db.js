const { Pool } = require('pg');

const uri = process.env.DATABASE_URL.replace(':6543/postgres?pgbouncer=true', ':5432/postgres');
const pool = new Pool({ connectionString: uri, ssl: { rejectUnauthorized: false } });

async function run() {
  const client = await pool.connect();
  try {
    await client.query('DROP TABLE IF EXISTS klines, klines_8h, klines_12h, klines_daily, klines_weekly, klines_monthly;');
    console.log('Tables dropped successfully via direct port 5432.');
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  } finally {
    client.release();
    process.exit(0);
  }
}
run();
