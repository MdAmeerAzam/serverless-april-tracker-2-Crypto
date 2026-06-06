const { pool } = require('./api/db.js');
async function check() {
  const { rows } = await pool.query("SELECT * FROM information_schema.table_constraints WHERE table_name IN ('klines', 'klines_12h', 'klines_daily', 'klines_weekly', 'klines_monthly')");
  console.log('Constraints:', rows.map(r => r.constraint_type));
  const { rows: views } = await pool.query("SELECT table_name FROM information_schema.views WHERE table_schema='public'");
  console.log('Views:', views.map(v => v.table_name));
  await pool.end();
}
check();
