process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { pool } = require('../api/db');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const path = require('path');

const SPREADSHEETS = {
    bitcoin: '12wWGLGhnQSDbHpvM3nn8gNs2Ip69TwmBnjlqWi-HV4o',
    crypto:  '1CoU7Df_HBGTqaV8nrt8b5pka0jWyXkYsgVh4Gukml8I',
    macro:   '1VytsJdr8EnKUXqxdMhvcDMzd9fCQowAPzayMWKKc4rA'
};

const BITCOIN_TABLES = ['klines', 'klines_12h', 'klines_daily', 'klines_weekly', 'klines_monthly'];

const CRYPTO_COMBOS = [];
for (const asset of ['btc', 'eth']) {
    for (const market of ['spot', 'futures']) {
        for (const interval of ['4h', '12h', 'daily', 'weekly', 'monthly']) {
            CRYPTO_COMBOS.push(`${asset}_${market}_${interval}`);
        }
    }
}

const HEADER_VALUES = ['id', 'timestamp', 'date', 'open', 'high', 'low', 'sar1', 'sar2', 'sar3', 'closevalue', 'closepts', 'closepct', 'closevol'];

async function getDoc(spreadsheetId) {
    const creds = require(path.join(process.cwd(), 'credentials.json'));
    const auth = new JWT({
        email: creds.client_email,
        key: creds.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.file'],
    });
    const doc = new GoogleSpreadsheet(spreadsheetId, auth);
    await doc.loadInfo();
    return doc;
}

async function backupTables(trackerName, spreadsheetId, tables) {
    console.log(`\n── ${trackerName}`);
    const doc = await getDoc(spreadsheetId);
    const client = await pool.connect();

    try {
        for (const tableName of tables) {
            process.stdout.write(`  → ${tableName}... `);
            try {
                let sheet = doc.sheetsByTitle[tableName];
                let maxTimestamp = 0;

                if (!sheet) {
                    sheet = await doc.addSheet({ title: tableName, headerValues: HEADER_VALUES });
                } else {
                    const existingRows = await sheet.getRows();
                    if (existingRows.length > 0) {
                        maxTimestamp = Number(existingRows[existingRows.length - 1].get('timestamp'));
                    }
                }

                const { rows: pgRows } = await client.query(
                    `SELECT * FROM ${tableName} WHERE timestamp >= $1 ORDER BY timestamp ASC`,
                    [maxTimestamp]
                );

                if (pgRows.length === 0) {
                    console.log('no new rows');
                    continue;
                }

                const toAppend = pgRows.map(r => ({
                    ...r,
                    date: new Date(Number(r.timestamp)).toISOString()
                }));

                if (maxTimestamp > 0 && pgRows.length > 0 && Number(pgRows[0].timestamp) === maxTimestamp) {
                    // Update last row (live candle refresh)
                    const existingRows = await sheet.getRows();
                    const lastRow = existingRows[existingRows.length - 1];
                    lastRow.assign(toAppend[0]);
                    await lastRow.save();
                    if (toAppend.length > 1) {
                        await sheet.addRows(toAppend.slice(1));
                    }
                } else {
                    await sheet.addRows(toAppend);
                }

                console.log(`${pgRows.length} rows pushed`);
            } catch (e) {
                console.log(`✖ ${e.message}`);
            }

            // Google Sheets API: 60 writes/min limit — pace at ~54 writes/min to stay safe
            await new Promise(res => setTimeout(res, 1100));
        }
    } finally {
        client.release();
    }
}

(async () => {
    try {
        console.log('\n[GitHub Actions] Starting Backup Run...\n');

        await backupTables('Bitcoin', SPREADSHEETS.bitcoin, BITCOIN_TABLES);
        await backupTables('Crypto',  SPREADSHEETS.crypto,  CRYPTO_COMBOS);

        console.log('\n[Backup Complete]\n');
        process.exit(0);
    } catch (err) {
        console.error('FATAL BACKUP ERROR:', err);
        process.exit(1);
    }
})();
