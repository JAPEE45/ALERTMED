const axios = require('axios');

// ==========================================
// ⚙️ CONFIGURE YOUR MEDICINE & HARDWARE DETAILS
// ==========================================
const TILE_PIN = 12;                     // Default pin number for the scheduled medicine tile
const MEDICINE_NAME = "Paracetamol";     // Name of the medicine
const SCHEDULE_TYPE = "once_daily";      // Type of schedule
const DAYS = "daily";                    // Days to dispense (e.g., "daily" or "Mon, Wed, Fri")

const SERVO_ESP32_URL = 'http://10.180.37.20:8080';  // Servo ESP32 base URL
const SERVER_URL = 'http://127.0.0.1:3000';          // Node.js server base URL
// ==========================================

async function rotatePin5Servo(degree) {
    const deg = parseInt(degree, 10);
    if (isNaN(deg) || deg < 0 || deg > 180) {
        console.error(`[ERROR] Invalid degree '${degree}'. Degree must be between 0 and 180.`);
        return false;
    }

    console.log(`\n[SERVO PIN 5] Sending command to rotate Pin 5 servo to ${deg} degrees...`);
    try {
        const res = await axios.get(`${SERVO_ESP32_URL}/spin?pin=5&degree=${deg}&duration=1000`, { timeout: 10000 });
        if (res.data && res.data.success !== false) {
            console.log(`[SUCCESS] Pin 5 servo rotated to ${deg} degrees!`);
            return true;
        } else {
            console.warn(`[WARNING] ESP32 response:`, res.data);
            return false;
        }
    } catch (err) {
        console.error(`[ERROR] Failed to rotate Pin 5 servo at ${SERVO_ESP32_URL}:`, err.message);
        return false;
    }
}

async function setMedicineAndSchedule() {
    const rawArgs = process.argv.slice(2);

    if (rawArgs.length < 1) {
        console.log("=========================================================");
        console.log("             AlertMed - Set Schedule & Servo             ");
        console.log("=========================================================");
        console.log("Usage: node set_schedule.js <time_HH:MM> [pin5_degree]");
        console.log("       node set_schedule.js <time_HH:MM> --degree <pin5_degree>");
        console.log("       node set_schedule.js --degree <pin5_degree>");
        console.log("");
        console.log("Examples:");
        console.log("  node set_schedule.js 22:50");
        console.log("  node set_schedule.js 22:50 90");
        console.log("  node set_schedule.js 22:50 --degree 180");
        console.log("  node set_schedule.js --degree 45");
        console.log("=========================================================");
        process.exit(1);
    }

    let time = null;
    let pin5Degree = null;

    // Parse arguments supporting both positional and flags
    for (let i = 0; i < rawArgs.length; i++) {
        const arg = rawArgs[i];
        if (arg === '--degree' || arg === '-d' || arg === '--deg') {
            if (i + 1 < rawArgs.length) {
                pin5Degree = rawArgs[i + 1];
                i++;
            }
        } else if (!time && /^([01]\d|2[0-3]):([0-5]\d)$/.test(arg)) {
            time = arg;
        } else if (!pin5Degree && !isNaN(parseInt(arg, 10)) && !arg.includes(':')) {
            pin5Degree = arg;
        }
    }

    // 1. If degree parameter is specified, rotate Pin 5 servo
    if (pin5Degree !== null) {
        await rotatePin5Servo(pin5Degree);
    }

    // 2. If time is specified, register medicine and set schedule on server
    if (time) {
        // Basic time format validation
        const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;
        if (!timeRegex.test(time)) {
            console.error("[ERROR] Invalid time format. Please use HH:MM (e.g., 08:30 or 14:45)");
            process.exit(1);
        }

        try {
            console.log(`\n[SCHEDULE] Setting up Tile (Pin ${TILE_PIN}) with ${MEDICINE_NAME}...`);
            
            // 1. Update medicine details on tile
            const updateRes = await axios.post(`${SERVER_URL}/api/update-medicine`, {
                pin: TILE_PIN,
                name: MEDICINE_NAME
            });
            
            if (updateRes.data.success) {
                console.log(`[SUCCESS] ${updateRes.data.message}`);
            } else {
                console.log(`[FAILED] ${updateRes.data.message}`);
            }

            // 2. Set the schedule for the tile
            console.log(`[SCHEDULE] Adding schedule at ${time}...`);
            const scheduleRes = await axios.post(`${SERVER_URL}/api/schedule`, {
                pin: TILE_PIN,
                time: time,
                schedule_type: SCHEDULE_TYPE,
                days: DAYS
            });
            
            if (scheduleRes.data.success) {
                console.log(`[SUCCESS] ${scheduleRes.data.message}`);
            } else {
                console.log(`[FAILED] ${scheduleRes.data.message}`);
            }

        } catch (error) {
            if (error.response) {
                console.error(`[ERROR] Server rejected request:`, error.response.data);
            } else {
                console.error(`[ERROR] Failed to connect to server at ${SERVER_URL}:`, error.message);
            }
        }
    }
}

setMedicineAndSchedule();
