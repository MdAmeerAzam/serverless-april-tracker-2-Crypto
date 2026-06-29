'use strict';
/**
 * crypto_verify_local.js — Step G3
 * Run AFTER crypto_genesis_local.js completes.
 * Run: node crypto_verify_local.js
 */

const Database = require('better-sqlite3');
const fs       = require('fs');
const path     = require('path');

const DB_PATH     = path.resolve(__dirname, 'crypto_genesis.db');
const REPORT_PATH = path.resolve(__dirname, 'genesis_audit_report.json');
const LOCK_MS     = 1749513599000; // June 9, 2026 23:59:59 UTC

if (!fs.existsSync(DB_PATH))     { console.error('[FATAL] crypto_genesis.db not found. Run genesis first.'); process.exit(1); }
if (!fs.existsSync(REPORT_PATH)) { console.error('[FATAL] genesis_audit_report.json not found. Run genesis first.'); process.exit(1); }

const db     = new Database(DB_PATH, { readonly: true });
const report = JSON.parse(fs.readFileSync(REPORT_PATH, 'utf8'));

console.log('='.repeat(60));
console.log('  CRYPTO GENESIS VERIFICATION');
console.log(`  Lock boundary: ${new Date(LOCK_MS).toISOString()}`);
console.log('='.repeat(60));

let totalPass = 0, totalFail = 0;
const verifyResults = {};

for (const [table, info] of Object.entries(report.tables)) {
    if (info.status === 'WARN_EMPTY' || info.status === 'FAIL') {
        console.log(`\n[SKIP] ${table}: was ${info.status} in genesis — cannot verify`);
        verifyResults[table] = { verified: false, reason: `Genesis status was ${info.status}` };
        totalFail++;
        continue;
    }

    console.log(`\n[VERIFY] ${table}`);
    const checks = [];

    // CHECK 1: Row count in SQLite matches audit report
    const cnt = db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get().c;
    checks.push({ check: 'row_count_match', pass: cnt === info.rows, detail: `DB: ${cnt}, Report: ${info.rows}` });

    // CHECK 2: No rows beyond lock boundary
    const beyondLock = db.prepare(`SELECT COUNT(*) as c FROM ${table} WHERE timestamp > ${LOCK_MS}`).get().c;
    checks.push({ check: 'lock_boundary', pass: beyondLock === 0, detail: `Rows beyond lock: ${beyondLock}` });

    // CHECK 3: SAR1 only zero for first 2 warmup rows max
    const sar1Zero = db.prepare(`SELECT COUNT(*) as c FROM ${table} WHERE sar1 = 0`).get().c;
    checks.push({ check: 'sar1_warmup_only', pass: sar1Zero <= 2, detail: `SAR1=0 count: ${sar1Zero} (allowed ≤2)` });

    // CHECK 4: At least 1 row has SAR3 != 0 (confirms SAR3 logic fired)
    const sar3NonZero = db.prepare(`SELECT COUNT(*) as c FROM ${table} WHERE sar3 != 0`).get().c;
    checks.push({ check: 'sar3_has_values', pass: sar3NonZero > 0, detail: `SAR3 non-zero rows: ${sar3NonZero}` });

    // CHECK 5: First and last timestamps within expected range
    const first = db.prepare(`SELECT MIN(timestamp) as t FROM ${table}`).get().t;
    const last  = db.prepare(`SELECT MAX(timestamp) as t FROM ${table}`).get().t;
    const lastOk = last <= LOCK_MS;
    checks.push({ check: 'last_candle_in_range', pass: lastOk, detail: `Last candle: ${new Date(last).toISOString()}` });

    const allPass = checks.every(c => c.pass);
    if (allPass) { totalPass++; console.log(`  [✔] ALL 5 CHECKS PASSED`); }
    else         { totalFail++; checks.filter(c => !c.pass).forEach(c => console.log(`  [✖] FAIL: ${c.check} — ${c.detail}`)); }

    checks.forEach(c => console.log(`     ${c.pass ? '✔' : '✖'} ${c.check}: ${c.detail}`));

    verifyResults[table] = { verified: allPass, checks };
}

// Write verification output
const verifyReport = { verifiedAt: new Date().toISOString(), totalPass, totalFail, allPassed: totalFail === 0, tables: verifyResults };
const verifyPath = path.resolve(__dirname, 'genesis_verify_report.json');
fs.writeFileSync(verifyPath, JSON.stringify(verifyReport, null, 2));

console.log('\n' + '='.repeat(60));
console.log(`  VERIFICATION: ${totalPass} PASS  ${totalFail} FAIL`);
if (totalFail === 0) {
    console.log('  ✅ ALL TABLES VERIFIED — SAFE TO PUSH TO SUPABASE');
    console.log('  NEXT: node crypto_push_supabase.js');
} else {
    console.log('  ❌ FAILURES DETECTED — DO NOT PUSH TO SUPABASE');
    console.log('  Review genesis_verify_report.json and re-run genesis for failed tables.');
}
console.log('='.repeat(60));

db.close();
