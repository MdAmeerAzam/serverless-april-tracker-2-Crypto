const { Pool } = require('pg');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs');

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const DB_URL = "postgresql://postgres.ybnpnpisvalswxyjjfvx:Qzh3nc8S%40UQezjc@aws-1-ap-northeast-1.pooler.supabase.com:6543/postgres?pgbouncer=true";
const pool = new Pool({
    connectionString: DB_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 30000 // 30 seconds to bypass the cloud lag
});

const CREDS = JSON.parse(fs.readFileSync('C:/Users/Ameer_Agent/.gemini/antigravity/brain/7a6e89cb-6bec-4b49-a5c2-7bd7a8770058/scratch/repos/serverless-april-tracker-2/credentials.json', 'utf8'));

const auth = new JWT({
    email: CREDS.client_email,
    key: CREDS.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

async function run() {
    console.log("=== LOCAL FORENSIC E2E AUDIT ===");
    const client = await pool.connect();
    
    // Crypto (Repo 2)
    const cryptoDoc = new GoogleSpreadsheet('1CoU7Df_HBGTqaV8nrt8b5pka0jWyXkYsgVh4Gukml8I', auth);
    await cryptoDoc.loadInfo();
    const cryptoTables = ['klines', 'btc_spot_4h']; // Sample
    console.log(`\n[REPO 2 - CRYPTO] Document loaded: ${cryptoDoc.title}`);
    for (const t of cryptoTables) {
        const { rows } = await client.query(`SELECT COUNT(*) FROM ${t}`);
        const dbCount = Number(rows[0].count);
        const sheet = cryptoDoc.sheetsByTitle[t];
        const sRows = sheet ? (await sheet.getRows()).length : 0;
        console.log(`  ${t.padEnd(15)} | DB: ${dbCount} | Sheet: ${sRows}`);
    }

    client.release();
    await pool.end();
}
run().catch(console.error);
