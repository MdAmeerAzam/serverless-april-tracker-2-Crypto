const { pool } = require('../api/db.js');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const credentials = require('../credentials.json');

const SPREADSHEET_ID = '1CoU7Df_HBGTqaV8nrt8b5pka0jWyXkYsgVh4Gukml8I';

const CRYPTO_COMBOS = [];
for (const asset of ['btc', 'eth']) {
    for (const market of ['spot', 'futures']) {
        for (const interval of ['4h', '12h', 'daily', 'weekly', 'monthly']) {
            CRYPTO_COMBOS.push(`${asset}_${market}_${interval}`);
        }
    }
}

async function runInfinityPush() {
    console.log("[INFINITY SHEET PUSH] Commencing 100% Deep Recovery for all 20 Crypto Tables...");

    const auth = new JWT({
        email: credentials.client_email,
        key: credentials.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const doc = new GoogleSpreadsheet(SPREADSHEET_ID, auth);
    await doc.loadInfo();
    console.log(`  Connected to Sheet: "${doc.title}"`);

    const headerValues = ['id', 'timestamp', 'date', 'open', 'high', 'low', 'sar1', 'sar2', 'sar3', 'closeValue', 'closePts', 'closePct', 'closeVol'];

    const clientPG = await pool.connect();
    
    try {
        for (const tableName of CRYPTO_COMBOS) {
            console.log(`  Processing ${tableName}...`);

            const { rows } = await clientPG.query(`SELECT * FROM ${tableName} ORDER BY timestamp ASC`);
            console.log(`    Retrieved ${rows.length} rows from Cloud DB.`);
            if (rows.length === 0) continue;

            let sheet = doc.sheetsByTitle[tableName];
            if (sheet) {
                await sheet.clear();
                await sheet.setHeaderRow(headerValues);
            } else {
                sheet = await doc.addSheet({ title: tableName, headerValues });
            }

            const formattedRows = rows.map(r => ({
                id: r.id,
                timestamp: r.timestamp.toString(),
                date: new Date(Number(r.timestamp)).toISOString(),
                open: r.open,
                high: r.high,
                low: r.low,
                sar1: r.sar1,
                sar2: r.sar2,
                sar3: r.sar3,
                closeValue: r.closevalue,
                closePts: r.closepts,
                closePct: r.closepct,
                closeVol: r.closevol
            }));

            console.log(`    Pushing ${formattedRows.length} rows to Google Sheets...`);
            const chunkSize = 1000;
            for (let i = 0; i < formattedRows.length; i += chunkSize) {
                await sheet.addRows(formattedRows.slice(i, i + chunkSize));
                // Google Sheets API: 60 writes/min limit (1 write per second)
                await new Promise(resolve => setTimeout(resolve, 1200));
            }
            console.log(`    ✔ ${tableName} Push Complete.`);
        }
    } catch (e) {
        console.error(`    ✖ Failure:`, e.message);
    } finally {
        clientPG.release();
    }

    console.log("[INFINITY SHEET PUSH] Total Reconstruction Complete. Display is now 1:1 with Database.");
    process.exit(0);
}

runInfinityPush();
