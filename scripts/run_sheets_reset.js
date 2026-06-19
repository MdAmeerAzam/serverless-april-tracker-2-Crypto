'use strict';
// run_sheets_reset.js — ONE-TIME full wipe + full push from Supabase → Google Sheets
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { Pool } = require('pg');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const path = require('path');
const fs = require('fs');

const SPREADSHEET_ID = '1CoU7Df_HBGTqaV8nrt8b5pka0jWyXkYsgVh4Gukml8I';

const CRYPTO_COMBOS = [];
for (const asset of ['btc', 'eth']) {
    for (const market of ['spot', 'futures']) {
        for (const interval of ['4h', '6h', '12h', 'daily', 'weekly', 'monthly']) {
            CRYPTO_COMBOS.push(`${asset}_${market}_${interval}`);
        }
    }
}

const HEADER_VALUES = ['id', 'timestamp', 'date', 'open', 'high', 'low', 'sar1', 'sar2', 'sar3', 'closeValue', 'closePts', 'closePct', 'closeVol'];

const pool = process.env.DATABASE_URL
    ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 5, connectionTimeoutMillis: 15000 })
    : new Pool({ host: 'aws-1-ap-northeast-1.pooler.supabase.com', port: 6543, database: 'postgres', user: 'postgres.ybnpnpisvalswxyjjfvx', password: 'Qzh3nc8S@UQezjc', ssl: { rejectUnauthorized: false }, max: 5, connectionTimeoutMillis: 15000 });

async function getDoc() {
    const credsPath = path.join(process.cwd(), 'credentials.json');
    const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
    const auth = new JWT({
        email: creds.client_email,
        key: creds.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.file'],
    });
    const doc = new GoogleSpreadsheet(SPREADSHEET_ID, auth);
    await doc.loadInfo();
    return doc;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
    console.log('\n============================================================');
    console.log('  CRYPTO GOOGLE SHEETS FULL RESET (G7)');
    console.log(`  Tables: ${CRYPTO_COMBOS.length}`);
    console.log('  WARNING: Deletes all tabs then re-inserts all rows');
    console.log('============================================================\n');

    const doc = await getDoc();
    console.log('Connected to: "' + doc.title + '"\n');

    // PHASE 1: Delete ALL existing tabs
    console.log('PHASE 1: Clearing all existing tabs...');
    const existingSheets = [...doc.sheetsByIndex];
    for (const sheet of existingSheets) {
        process.stdout.write('  → Deleting "' + sheet.title + '"... ');
        try {
            await sheet.delete();
            console.log('deleted');
        } catch (e) {
            await sheet.clear();
            console.log('cleared (last tab)');
        }
        await sleep(1200);
    }
    console.log('\nPhase 1 complete.\n');

    // PHASE 2: Pull ALL data from Supabase
    console.log('PHASE 2: Pulling all rows from Supabase...');
    const client = await pool.connect();
    const allData = {};
    let totalFetched = 0;
    try {
        for (const table of CRYPTO_COMBOS) {
            const { rows } = await client.query(
                'SELECT id, timestamp, open, high, low, closevalue, closepts, closepct, closevol, sar1, sar2, sar3 FROM ' + table + ' ORDER BY timestamp ASC'
            );
            allData[table] = rows;
            totalFetched += rows.length;
            console.log('  fetched ' + table + ': ' + rows.length + ' rows');
        }
    } finally {
        client.release();
        await pool.end();
    }
    console.log('\nPhase 2 complete. Total fetched: ' + totalFetched + '\n');

    // PHASE 3: Write to Google Sheets
    console.log('PHASE 3: Writing to Google Sheets (~10 min)...\n');
    const BATCH = 1000;
    let pushed = 0;

    for (const table of CRYPTO_COMBOS) {
        const rows = allData[table];
        if (!rows || rows.length === 0) { console.log('  [SKIP] ' + table); continue; }

        process.stdout.write('  → ' + table + ' (' + rows.length + ' rows)... ');
        try {
            await doc.loadInfo();
            let sheet = doc.sheetsByTitle[table];
            if (!sheet) {
                sheet = await doc.addSheet({ title: table, headerValues: HEADER_VALUES });
            } else {
                await sheet.clear();
                await sheet.setHeaderRow(HEADER_VALUES);
            }
            await sleep(800);

            const formatted = rows.map(r => ({
                id: String(r.id), timestamp: Number(r.timestamp),
                date: new Date(Number(r.timestamp)).toISOString(),
                open: Number(r.open), high: Number(r.high), low: Number(r.low),
                sar1: Number(r.sar1), sar2: Number(r.sar2), sar3: Number(r.sar3),
                closeValue: Number(r.closevalue), closePts: Number(r.closepts),
                closePct: Number(r.closepct), closeVol: Number(r.closevol)
            }));

            for (let i = 0; i < formatted.length; i += BATCH) {
                await sheet.addRows(formatted.slice(i, i + BATCH));
                await sleep(1100);
            }

            pushed += rows.length;
            console.log('OK ' + rows.length + ' written');
        } catch (e) {
            console.log('FAIL: ' + e.message);
        }
        await sleep(1200);
    }

    console.log('\n============================================================');
    console.log('  SHEETS RESET COMPLETE');
    console.log('  Rows pushed: ' + pushed + ' / ' + totalFetched);
    console.log('============================================================\n');
    process.exit(0);
}

main().catch(e => { console.error('[FATAL]', e.message); process.exit(1); });
