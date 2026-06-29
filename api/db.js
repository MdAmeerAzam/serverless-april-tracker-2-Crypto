process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const { Pool } = require('pg');

// DATABASE_URL must be set via GitHub Actions Secrets (production) or .env (local).
// See .env.example. Never hard-code credentials.
if (!process.env.DATABASE_URL) {
    throw new Error('[db.js] DATABASE_URL is not set. Set it in GitHub Secrets or .env.');
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 20,
    idleTimeoutMillis: 1000,
    connectionTimeoutMillis: 10000
});

module.exports = { pool };
