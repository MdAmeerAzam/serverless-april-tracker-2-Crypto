const { pool } = require('./db');

const BITCOIN_TABLES = ['klines', 'klines_12h', 'klines_daily', 'klines_weekly', 'klines_monthly'];

const CRYPTO_ASSETS = ['btc', 'eth'];
const CRYPTO_MARKETS = ['spot', 'futures'];
const CRYPTO_INTERVALS = ['4h', '12h', 'daily', 'weekly', 'monthly'];

const MACRO_ASSETS = ['gold', 'silver', 'brent', 'wti', 'natgas'];
const MACRO_MARKETS = ['spot', 'futures'];
const MACRO_INTERVALS = ['daily', 'weekly', 'monthly'];

module.exports = async (req, res) => {
    try {
        const tables = [...BITCOIN_TABLES];

        // Hydrating schema arrays
        for (const a of CRYPTO_ASSETS) {
            for (const m of CRYPTO_MARKETS) {
                for (const i of CRYPTO_INTERVALS) {
                    tables.push(`${a}_${m}_${i}`);
                }
            }
        }

        for (const a of MACRO_ASSETS) {
            for (const m of MACRO_MARKETS) {
                for (const i of MACRO_INTERVALS) {
                    tables.push(`${a}_${m}_${i}`);
                }
            }
        }

        const client = await pool.connect();
        try {
            console.log(`[Supabase Handshake] Structuring ${tables.length} arrays...`);
            
            for (const table of tables) {
                const query = `
                    CREATE TABLE IF NOT EXISTS ${table} (
                        id SERIAL PRIMARY KEY,
                        timestamp BIGINT UNIQUE,
                        open REAL,
                        high REAL,
                        low REAL,
                        sar1 REAL,
                        sar2 REAL,
                        sar3 REAL,
                        closeValue REAL,
                        closePts REAL,
                        closePct REAL,
                        closeVol REAL
                    );
                `;
                await client.query(query);
            }
        } finally {
            client.release();
        }

        res.status(200).json({ success: true, message: `Successfully structured ${tables.length} PG Serverless tracking tables in Supabase.` });

    } catch (err) {
        console.error("Initialization Failed:", err);
        res.status(500).json({ success: false, error: err.message });
    }
};
