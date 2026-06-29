const { Client } = require('pg');

// DATABASE_URL must be set via GitHub Actions Secrets (production) or .env (local).
// Never hard-code credentials. See .env.example for local setup.
function getDbConfig() {
    if (!process.env.DATABASE_URL) {
        throw new Error('[mutex.js] DATABASE_URL is not set. Set it in GitHub Secrets or .env.');
    }
    return { connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } };
}

async function acquireGlobalLock(lockId, lockedBy, ttlMinutes = 60) {
    const client = new Client(getDbConfig());
    client.on('error', () => {});
    await client.connect();
    
    try {
        // Deadlock Immunity: Purge ghost locks older than their TTL
        await client.query(`DELETE FROM system_locks WHERE expires_at < NOW()`);
        
        // Attempt Atomic Mutex Acquisition
        const res = await client.query(`
            INSERT INTO system_locks (lock_id, locked_by, expires_at) 
            VALUES ($1, $2, NOW() + interval '${ttlMinutes} minutes')
            ON CONFLICT (lock_id) DO NOTHING
            RETURNING lock_id
        `, [lockId, lockedBy]);

        return res.rowCount > 0; 
    } finally {
        await client.end().catch(()=>{});
    }
}

async function isSystemLocked(lockId) {
    // Randomized jitter to stagger identical cron fires
    const jitterMs = Math.floor(Math.random() * 2900) + 100;
    await new Promise(r => setTimeout(r, jitterMs));

    const client = new Client(getDbConfig());
    client.on('error', () => {});

    try {
        await client.connect();
        await client.query(`DELETE FROM system_locks WHERE expires_at < NOW()`);
        const res = await client.query(`SELECT * FROM system_locks WHERE lock_id = $1`, [lockId]);
        return res.rows.length > 0;
    } catch (e) {
        // If PgBouncer at connection limit, gracefully defer
        if (e.message.includes('timeout') || e.code === 'ECONNRESET') {
            console.log('[MUTEX OVERLOAD] DB connection limit reached. Gracefully deferring.');
            return true;
        }
        throw e;
    } finally {
        await client.end().catch(() => {});
    }
}

async function releaseGlobalLock(lockId) {
    const client = new Client(getDbConfig());
    client.on('error', () => {});
    await client.connect();
    
    try {
        await client.query(`DELETE FROM system_locks WHERE lock_id = $1`, [lockId]);
    } finally {
        await client.end().catch(()=>{});
    }
}

module.exports = { acquireGlobalLock, isSystemLocked, releaseGlobalLock };
