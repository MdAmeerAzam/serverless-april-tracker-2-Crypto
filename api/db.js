process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const { Pool } = require('pg');

const rawUri = process.env.DATABASE_URL || "postgresql://postgres.ybnpnpisvalswxyjjfvx:Qzh3nc8S%40UQezjc@aws-1-ap-northeast-1.pooler.supabase.com:6543/postgres?pgbouncer=true";
const uri = rawUri;

const pool = new Pool({
    connectionString: uri,
    ssl: { rejectUnauthorized: false },
    max: 20, 
    idleTimeoutMillis: 1000, 
    connectionTimeoutMillis: 5000 
});

module.exports = { pool };
