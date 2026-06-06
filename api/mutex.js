const { Client } = require('pg');

async function acquireGlobalLock(lockId, lockedBy, ttlMinutes = 60) {
    const client = new Client({ 
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    });
    client.on('error', () => {}); // Neutralize async TCP drops
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
    const client = new Client({ 
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    });
    client.on('error', () => {});
    await client.connect();
    
    try {
        await client.query(`DELETE FROM system_locks WHERE expires_at < NOW()`);
        const res = await client.query(`SELECT * FROM system_locks WHERE lock_id = $1`, [lockId]);
        return res.rows.length > 0;
    } finally {
        await client.end().catch(()=>{});
    }
}

async function releaseGlobalLock(lockId) {
    const client = new Client({ 
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    });
    client.on('error', () => {});
    await client.connect();
    
    try {
        await client.query(`DELETE FROM system_locks WHERE lock_id = $1`, [lockId]);
    } finally {
        await client.end().catch(()=>{});
    }
}

module.exports = { acquireGlobalLock, isSystemLocked, releaseGlobalLock };
