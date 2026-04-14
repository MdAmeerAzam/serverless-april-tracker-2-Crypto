const { pool } = require('./db');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const path = require('path');
const fs = require('fs');

const CREDENTIALS_PATH = path.join(process.cwd(), 'credentials.json');
const SPREADSHEETS = {
    bitcoin: '12wWGLGhnQSDbHpvM3nn8gNs2Ip69TwmBnjlqWi-HV4o',
    macro: '1VytsJdr8EnKUXqxdMhvcDMzd9fCQowAPzayMWKKc4rA',
    crypto: '1CoU7Df_HBGTqaV8nrt8b5pka0jWyXkYsgVh4Gukml8I'
};

const TIMEFRAMES = ['4h', '12h', 'daily', 'weekly', 'monthly'];

let cachedDocs = {};

async function authenticateDocs(tracker) {
    if (cachedDocs[tracker]) return cachedDocs[tracker];

    const creds = require('../config.js');
    const serviceAccountAuth = new JWT({
        email: creds.client_email,
        key: creds.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.file'],
    });

    const doc = new GoogleSpreadsheet(SPREADSHEETS[tracker], serviceAccountAuth);
    await doc.loadInfo();
    cachedDocs[tracker] = doc;
    return cachedDocs[tracker];
}

// Micro-Transaction Endpoint: /api/backup?tracker=crypto&asset=eth&market=spot
module.exports = async (req, res) => {
    const { tracker, asset, market } = req.query;

    if (!tracker || !asset || !market) {
        return res.status(400).json({ error: "Missing micro-transaction block coordinates (tracker, file, market)." });
    }

    try {
        const doc = await authenticateDocs(tracker);
        
        let targetIntervals = TIMEFRAMES;
        if (tracker === 'macro') {
            targetIntervals = ['daily', 'weekly', 'monthly'];
        }

        let tablesTofetch = [];
        
        if (tracker === 'bitcoin' && asset === 'btc') {
            tablesTofetch = ['klines', 'klines_12h', 'klines_daily', 'klines_weekly', 'klines_monthly'];
        } else {
            tablesTofetch = targetIntervals.map(i => `${asset}_${market}_${i}`);
        }

        const client = await pool.connect();
        try {
            for (const tableName of tablesTofetch) {
                let sheet = doc.sheetsByTitle[tableName];
                const headerValues = ['id', 'timestamp', 'date', 'open', 'high', 'low', 'sar1', 'sar2', 'sar3', 'closeValue', 'closePts', 'closePct', 'closeVol'];
                
                let maxTimestamp = 0;
                let existingRows = [];

                if (!sheet) {
                    sheet = await doc.addSheet({ title: tableName, headerValues });
                } else {
                    existingRows = await sheet.getRows();
                    if (existingRows.length > 0) {
                        maxTimestamp = Number(existingRows[existingRows.length - 1].get('timestamp'));
                    }
                }

                const { rows: pgRows } = await client.query(`SELECT * FROM ${tableName} WHERE timestamp >= $1 ORDER BY timestamp ASC`, [maxTimestamp]);
                
                if (pgRows.length === 0) continue;
                
                let rowsToAppend = pgRows;
                let rowsUpdated = 0;

                if (maxTimestamp > 0 && pgRows[0].timestamp === String(maxTimestamp) && existingRows.length > 0) {
                    const lastRowToUpdate = existingRows[existingRows.length - 1];
                    const r = pgRows[0];
                    lastRowToUpdate.assign(r);
                    await lastRowToUpdate.save();
                    rowsUpdated = 1;
                    rowsToAppend = pgRows.slice(1);
                }

                if (rowsToAppend.length > 0) {
                    const appendData = rowsToAppend.map(r => ({ ...r, date: new Date(Number(r.timestamp)).toISOString() }));
                    // Google API enforces 60 writes per minute, bulk appending is considered 1 write natively.
                    await sheet.addRows(appendData);
                }
            }
        } finally {
            client.release();
        }

        res.status(200).json({ success: true, message: `Backup array strictly pushed to physical Cloud DB for ${asset}_${market}` });

    } catch (err) {
        console.error("Backup Failure Edge:", err);
        res.status(500).json({ success: false, error: err.message });
    }
};
