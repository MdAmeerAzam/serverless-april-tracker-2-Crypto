process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const { Pool } = require('pg');

const uri = process.env.DATABASE_URL || "postgresql://postgres.ybnpnpisvalswxyjjfvx:Qzh3nc8S%40UQezjc@aws-1-ap-northeast-1.pooler.supabase.com:5432/postgres?pgbouncer=true";

// Vercel Serverless requires pooled connections to prevent hitting Supabase instance thread limits
const pool = new Pool({
    connectionString: uri,
    ssl: { rejectUnauthorized: false },
    max: 5,  // Strict limitation to bypass hobby limit bottlenecks
    idleTimeoutMillis: 5000,
    connectionTimeoutMillis: 5000
});

module.exports = { pool };
