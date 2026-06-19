process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const { Pool } = require('pg');

// Use DATABASE_URL env var (GitHub Actions) or fall back to explicit connection object
const pool = process.env.DATABASE_URL
    ? new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
        max: 20,
        idleTimeoutMillis: 1000,
        connectionTimeoutMillis: 10000
    })
    : new Pool({
        host: 'aws-1-ap-northeast-1.pooler.supabase.com',
        port: 6543,
        database: 'postgres',
        user: 'postgres.ybnpnpisvalswxyjjfvx',
        password: 'Qzh3nc8S@UQezjc',
        ssl: { rejectUnauthorized: false },
        max: 20,
        idleTimeoutMillis: 1000,
        connectionTimeoutMillis: 10000
    });

module.exports = { pool };
