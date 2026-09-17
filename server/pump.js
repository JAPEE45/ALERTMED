const axios = require('axios');

const ULTRASONIC_ESP32_URL = 'http://10.180.37.21';

async function runPump() {
    const args = process.argv.slice(2);
    if (args.length === 0) {
        console.error("Please provide the milliseconds parameter.");
        console.log("Usage: node pump.js <milliseconds>");
        console.log("Example: node pump.js 5000");
        process.exit(1);
    }

    const durationMs = parseInt(args[0], 10);
    if (isNaN(durationMs) || durationMs <= 0) {
        console.error("Invalid duration. Please provide a positive number of milliseconds.");
        process.exit(1);
    }
    try {
        await axios.get(`${ULTRASONIC_ESP32_URL}/relay/pump?ms=${durationMs}`, { timeout: 5000 });
        console.log(`[SUCCESS] Pump started. It will automatically turn off after ${durationMs} ms.`);
    } catch (error) {
        console.error(`[ERROR] Failed to communicate with ESP32 to start pump: ${error.message}`);
        process.exit(1);
    }
}

runPump();
