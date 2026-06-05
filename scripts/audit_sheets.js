process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { pool } = require('../api/db');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

const SPREADSHEETS = {
    crypto: '1CoU7Df_HBGTqaV8nrt8b5pka0jWyXkYsgVh4Gukml8I'
};

const TABLES = [
    'klines', 'klines_12h', 'klines_daily', 'klines_weekly', 'klines_monthly',
    'btc_spot_4h', 'btc_spot_12h', 'btc_spot_daily', 'btc_spot_weekly', 'btc_spot_monthly',
    'btc_futures_4h', 'btc_futures_12h', 'btc_futures_daily', 'btc_futures_weekly', 'btc_futures_monthly',
    'eth_spot_4h', 'eth_spot_12h', 'eth_spot_daily', 'eth_spot_weekly', 'eth_spot_monthly',
    'eth_futures_4h', 'eth_futures_12h', 'eth_futures_daily', 'eth_futures_weekly', 'eth_futures_monthly'
];

async function getDoc(spreadsheetId) {
    const credsStr = process.env.GOOGLE_CREDENTIALS_JSON;
    if (!credsStr) throw new Error('GOOGLE_CREDENTIALS_JSON not found');
    const creds = JSON.parse(credsStr);
    
    const auth = new JWT({
        email: creds.client_email,
        key: creds.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.file'],
    });
    const doc = new GoogleSpreadsheet(spreadsheetId, auth);
    await doc.loadInfo();
    return doc;
}

(async () => {
    let client;
    try {
        console.log('=== EXACT ROW COUNT AUDIT ===\n');
        client = await pool.connect();
        const dbCounts = {};
        for (const tableName of TABLES) {
            try {
                const { rows } = await client.query(`SELECT COUNT(*) as count FROM ${tableName}`);
                dbCounts[tableName] = parseInt(rows[0].count, 10);
            } catch(e) {
                dbCounts[tableName] = -1; // error
            }
        }
        client.release();
        client = null;
        await pool.end(); // Sever pool completely to avoid background TCP timeout crashes
        
        const docCrypto = await getDoc(SPREADSHEETS.crypto);
        
        console.log('| Table Name | Database Rows | Sheet Rows | DB Cells | Sheet Cells | Match |');
        console.log('|------------|---------------|------------|----------|-------------|-------|');

        let totalDbRows = 0;
        let totalSheetRows = 0;

        for (const tableName of TABLES) {
            const dbCount = dbCounts[tableName];
            let sheetCount = 0;
            
            // Get Sheet count
            try {
                const sheet = docCrypto.sheetsByTitle[tableName];
                if (sheet) {
                    const sheetRows = await sheet.getRows();
                    sheetCount = sheetRows.length;
                } else {
                    sheetCount = 0;
                }
            } catch(e) {
                sheetCount = -1;
            }

            const dbCells = dbCount > 0 ? dbCount * 13 : 0; // 13 columns
            const sheetCells = sheetCount > 0 ? sheetCount * 13 : 0;
            const match = dbCount === sheetCount ? 'YES' : 'NO';

            totalDbRows += Math.max(0, dbCount);
            totalSheetRows += Math.max(0, sheetCount);

            console.log(`| ${tableName.padEnd(20)} | ${String(dbCount).padEnd(13)} | ${String(sheetCount).padEnd(10)} | ${String(dbCells).padEnd(8)} | ${String(sheetCells).padEnd(11)} | ${match.padEnd(5)} |`);
        }

        console.log('\n--- TOTALS ---');
        console.log(`Total Database Rows: ${totalDbRows}`);
        console.log(`Total Google Sheets Rows: ${totalSheetRows}`);
        const totMatch = totalDbRows === totalSheetRows ? '100% MATCHED' : 'MISMATCH DETECTED';
        console.log(`Overall Status: ${totMatch}\n`);

        console.log('=== AUDIT COMPLETE ===');
        process.exit(0);
    } catch (err) {
        console.error('FATAL AUDIT ERROR:', err);
        process.exit(1);
    } finally {
        if (client) client.release();
    }
})();
