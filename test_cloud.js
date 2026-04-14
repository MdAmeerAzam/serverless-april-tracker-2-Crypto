(async () => {
    try {
        console.log("--- E2E PRODUCTION CLOUD DIAGNOSTIC ---");
        
        console.log("1. Pinging Live Vercel Sync Engine (Bitcoin 4h)...");
        let start = Date.now();
        let res = await fetch("https://serverless-april-tracker.vercel.app/api/sync?tracker=bitcoin&asset=btc&market=spot&interval=4h");
        let text = await res.text();
        try { console.log(`[${Date.now() - start}ms] SYNC RESULT:`, JSON.parse(text)); } catch(e) { console.log(`[${Date.now() - start}ms] SYNC TEXT:`, text); }

        console.log("2. Pinging Live Vercel Backup Engine (Bitcoin Google Sheets Array)...");
        start = Date.now();
        res = await fetch("https://serverless-april-tracker.vercel.app/api/backup?tracker=bitcoin&asset=btc&market=spot");
        text = await res.text();
        try { console.log(`[${Date.now() - start}ms] BACKUP RESULT:`, JSON.parse(text)); } catch(e) { console.log(`[${Date.now() - start}ms] BACKUP TEXT:`, text); }

        console.log("Cloud E2E Successfully Concluded.");
        process.exit(0);
    } catch(err) {
        console.error("FATAL CLOUD PING ERROR:", err);
        process.exit(1);
    }
})();
