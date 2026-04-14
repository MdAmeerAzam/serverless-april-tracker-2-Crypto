const sync = require('./api/sync.js');
const backup = require('./api/backup.js');

function createRes(name) {
    return {
        status: (code) => ({
            json: (data) => {
                console.log(`[${name} RESULT] Status ${code}: ${JSON.stringify(data)}`);
            }
        })
    };
}

(async () => {
    try {
        console.log("--- Executing Vercel Micro-Transaction Sync Target [macro: gold: spot: daily] ---");
        await sync({ query: { tracker: 'macro', asset: 'gold', market: 'spot', interval: 'daily' } }, createRes('SYNC'));
        
        console.log("--- Executing Google Sheets Cloud Backup Target [macro: gold: spot] ---");
        await backup({ query: { tracker: 'macro', asset: 'gold', market: 'spot' } }, createRes('BACKUP'));

        console.log("All Serverless E2E Execution Blocks Completed Successfully.");
        process.exit(0);
    } catch(err) {
        console.error("E2E Verification Fatal Failure:", err);
        process.exit(1);
    }
})();
