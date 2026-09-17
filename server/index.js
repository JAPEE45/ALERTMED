const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cron = require('node-cron');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const { spawn } = require('child_process');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = 3000;
// ⚠️ IMPORTANT: Update this IP address to match what the ESP32 prints in the Arduino Serial Monitor!
const ESP32_BASE_URL = 'http://10.180.37.20:8080'; 
const ULTRASONIC_ESP32_URL = 'http://10.180.37.21'; // Must match the static IP set in ULTRASONIC.ino

// Helper functions to notify Ultrasonic ESP32 of face verification status
function notifyUltrasonicFaceVerified(name) {
    axios.get(`${ULTRASONIC_ESP32_URL}/face/verified`, { timeout: 3000 })
        .then(() => console.log(`[ESP32] Notified Ultrasonic ESP32: Registered face '${name || ""}' verified. Ultrasonic armed.`))
        .catch(err => console.warn(`[ESP32 WARNING] Could not notify Ultrasonic ESP32 of face verification: ${err.message}`));
}

function notifyUltrasonicFaceReset() {
    axios.get(`${ULTRASONIC_ESP32_URL}/face/reset`, { timeout: 3000 })
        .then(() => console.log(`[ESP32] Notified Ultrasonic ESP32: Face reset / Ultrasonic ignoring objects.`))
        .catch(() => {});
}

let db;

// Define the hardware pins available for the tiles
const AVAILABLE_PINS = [19, 18, 5, 12, 14, 27, 26, 25, 33];

// Initialize Database
async function initDB() {
    db = await open({
        filename: './alertmed.db',
        driver: sqlite3.Database
    });

    // Create Tables
    await db.exec(`
        CREATE TABLE IF NOT EXISTS tiles (
            pin INTEGER PRIMARY KEY,
            medicine_name TEXT DEFAULT 'Empty',
            count INTEGER DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS schedules (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pin INTEGER,
            time TEXT,
            FOREIGN KEY(pin) REFERENCES tiles(pin)
        );
        CREATE TABLE IF NOT EXISTS dispense_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pin INTEGER,
            medicine_name TEXT,
            dispensed_at TEXT DEFAULT (datetime('now', 'localtime')),
            status TEXT DEFAULT 'dispensed'
        );
    `);

    // Add new columns to existing tables without crashing if they already exist
    await db.run(`ALTER TABLE schedules ADD COLUMN schedule_type TEXT DEFAULT 'once_daily'`).catch(() => {});
    await db.run(`ALTER TABLE schedules ADD COLUMN days TEXT DEFAULT 'daily'`).catch(() => {});
    await db.run(`ALTER TABLE schedules ADD COLUMN med_type TEXT DEFAULT 'solid'`).catch(() => {});
    await db.run(`ALTER TABLE schedules ADD COLUMN amount INTEGER DEFAULT 1`).catch(() => {});
    await db.run(`ALTER TABLE schedules ADD COLUMN ms INTEGER DEFAULT 0`).catch(() => {});
    await db.run(`ALTER TABLE tiles ADD COLUMN current_degree INTEGER DEFAULT 0`).catch(() => {});
    await db.run(`ALTER TABLE dispense_history ADD COLUMN patient_name TEXT DEFAULT NULL`).catch(() => {});

    // Seed available tiles if they don't exist
    for (const pin of AVAILABLE_PINS) {
        const existing = await db.get('SELECT pin FROM tiles WHERE pin = ?', pin);
        if (!existing) {
            await db.run('INSERT INTO tiles (pin, medicine_name, count) VALUES (?, ?, ?)', [pin, 'Empty', 0]);
        }
    }
    console.log('[DB] SQLite Database initialized with tiles.');
}

// --- Helper Functions ---

const activePins = new Set();
const pendingDispenseQueue = new Set(); // Queue for holding scheduled dispenses

// Multi-stage verification state:
// Step 1: Schedule is up -> Added to pendingDispenseQueue (WAITING_FOR_FACE)
// Step 2: Registered face detected -> isFaceVerified = true (WAITING_FOR_ULTRASONIC)
// Step 3: Ultrasonic detects object within 20 inches (~50.8 cm) -> ACTIVATE DISPENSE!
let isFaceVerified = false;
let verifiedFaceName = null;
let faceVerifiedTime = null;
let lastUltrasonicEvent = null;
const FACE_VERIFICATION_TIMEOUT_MS = 120000; // 2 minutes window to approach dispenser after face is recognized

// Missed Schedule Configuration (3 minutes = 180,000 ms)
const SCHEDULE_MISSED_TIMEOUT_MS = 3 * 60 * 1000;
const pendingScheduleTimers = new Map(); // pin -> { timer, queuedAt }

// --- Continuous Real-time Status Logger ---
let statusLoggerInterval = null;

function startStatusLogger() {
    if (statusLoggerInterval) return;
    statusLoggerInterval = setInterval(() => {
        if (pendingDispenseQueue.size === 0) {
            stopStatusLogger();
            return;
        }

        const stepNum = !isFaceVerified ? "1/3" : "2/3";
        const stepName = !isFaceVerified ? "WAITING_FOR_FACE" : "WAITING_FOR_ULTRASONIC_OBJECT";
        const faceStatus = isFaceVerified ? `YES ('${verifiedFaceName}')` : "NO";
        const willDispense = "NO";
        const reason = !isFaceVerified 
            ? "Waiting for registered face to be detected first" 
            : "Waiting for person/object within 20 inches (50.8 cm)";

        const queuedPins = Array.from(pendingDispenseQueue).join(', ');

        console.log(`[STATUS ${stepNum}: ${stepName}] Pin(s) Queued: [${queuedPins}] | Face Detected: ${faceStatus} | Object in 20" Range: NO | Will Dispense Now?: ${willDispense} (${reason})`);
    }, 4000);
}

function stopStatusLogger() {
    if (statusLoggerInterval) {
        clearInterval(statusLoggerInterval);
        statusLoggerInterval = null;
    }
}

// Function to handle a missed schedule when 3 minutes elapse without verification & proximity
async function handleMissedSchedule(pin) {
    if (!pendingDispenseQueue.has(pin)) {
        return; // Already dispensed or removed
    }

    console.log(`\n========================================================================`);
    console.log(`[MISSED SCHEDULE] 3 minutes elapsed without face & proximity verification for Tile (Pin ${pin})!`);
    console.log(`  - Face & Object proximity NOT detected within 3 minutes.`);
    console.log(`  - Will Dispense Now?: NO (Schedule expired)`);
    console.log(`  - Result: Saved to database as 'missed', removed from active queue.`);
    console.log(`========================================================================\n`);

    try {
        const tile = await db.get('SELECT * FROM tiles WHERE pin = ?', pin);
        const medicineName = tile ? tile.medicine_name : 'Unknown Medicine';

        // Save missed record to database
        await db.run(
            'INSERT INTO dispense_history (pin, medicine_name, status, patient_name) VALUES (?, ?, ?, ?)',
            [pin, medicineName, 'missed', 'Missed (No Face/Proximity Detected)']
        );
        console.log(`[DB] Logged missed schedule for Pin ${pin} (${medicineName}) to dispense_history.`);
    } catch (err) {
        console.error(`[ERROR] Failed to record missed schedule for Pin ${pin}:`, err.message);
    }

    // Remove from pending queue as up
    pendingDispenseQueue.delete(pin);
    pendingScheduleTimers.delete(pin);

    // If no more items are queued, stop buzzer, release webcam, and reset state to IDLE
    if (pendingDispenseQueue.size === 0) {
        isFaceVerified = false;
        verifiedFaceName = null;
        faceVerifiedTime = null;
        lastUltrasonicEvent = null;
        stopCameraService();
        stopStatusLogger();
        console.log(`[INFO] No more schedules pending. Stopping buzzer... State is now IDLE.`);
        try {
            axios.get(`${ULTRASONIC_ESP32_URL}/buzzer/stop`, { timeout: 3000 }).catch(() => {});
            notifyUltrasonicFaceReset();
        } catch (e) {}
    }
}

// Function to trigger the ESP32 and update count
async function dispenseMedicine(pin, patientName = null) {
    if (activePins.has(pin)) {
        console.log(`[INFO] Pin ${pin} is already rotating. Ignoring duplicate request.`);
        return { success: false, message: "Servo is currently busy" };
    }

    const tile = await db.get('SELECT * FROM tiles WHERE pin = ?', pin);
    if (!tile) return { success: false, message: "Invalid pin/tile" };
    
    // Check if this pin has a schedule to find the dispense amount (default to 1 if not)
    const sched = await db.get('SELECT amount, med_type, ms FROM schedules WHERE pin = ?', pin);
    const amount = sched ? sched.amount : 1;
    const medType = sched ? sched.med_type : (Number(pin) === 13 ? 'liquid' : 'solid');
    const msAmount = sched ? sched.ms : ((amount / 2.5) * 1900);

    if (tile.count < amount) {
        console.log(`[WARNING] Tile (Pin ${pin}) doesn't have enough meds! Needs ${amount}, has ${tile.count}`);
        return { success: false, message: "Not enough medicine loaded" };
    }

    activePins.add(pin);
    try {
        if (medType === 'liquid' || Number(pin) === 13) {
            console.log(`[INFO] Sending pump command to ESP32 for Pin 13 (${msAmount} ms)...`);
            await axios.get(`${ULTRASONIC_ESP32_URL}/relay/pump?ms=${msAmount}`, { timeout: 15000 });
        } else {
            // Calculate absolute target degree (40 degrees per medicine)
            // If current degree has reached or exceeded 180, wrap back to 0 so servo continues dispensing
            let currentDeg = tile.current_degree || 0;
            if (currentDeg >= 180) {
                currentDeg = 0;
            }
            let newDegree = currentDeg + (amount * 40);
            if (newDegree > 180) {
                newDegree = 0;
            }
            
            console.log(`[INFO] Spinning Servo Pin ${pin} from ${currentDeg} to ${newDegree} degrees (amount: ${amount})...`);
            const response = await axios.get(`${ESP32_BASE_URL}/spin?pin=${pin}&degree=${newDegree}`, { timeout: 15000 });
            
            if (response.data && response.data.success === false) {
                console.error(`[ERROR] ESP32 rejected command: ${response.data.message}`);
                return { success: false, message: response.data.message };
            }
            
            // Save the new degree to the database
            await db.run('UPDATE tiles SET current_degree = ? WHERE pin = ?', [newDegree, pin]);
        }
        
        // Update local count in DB
        const newCount = tile.count - amount;
        await db.run('UPDATE tiles SET count = ? WHERE pin = ?', [newCount, pin]);
        
        // Log this dispense
        await db.run(
            'INSERT INTO dispense_history (pin, medicine_name, status, patient_name) VALUES (?, ?, ?, ?)',
            [pin, tile.medicine_name, 'dispensed', patientName || 'Verified Patient']
        );
        console.log(`[SUCCESS] Dispensed ${amount}x ${tile.medicine_name} to ${patientName || 'Verified Patient'}. Remaining count: ${newCount}`);
        
        // Return servo to 0 degrees if completely empty
        if (newCount <= 0 && medType !== 'liquid' && Number(pin) !== 13) {
            console.log(`[INFO] Tile ${pin} is now empty. Resetting servo to 0 degrees.`);
            await axios.get(`${ESP32_BASE_URL}/spin?pin=${pin}&degree=0`, { timeout: 15000 }).catch(e => {});
            await db.run('UPDATE tiles SET current_degree = 0 WHERE pin = ?', [pin]);
        }
        
        return { success: true, count: newCount };
    } catch (error) {
        console.error(`[ERROR] Failed to reach ESP32 for Pin ${pin}:`, error.message);
        return { success: false, message: "Failed to connect to ESP32 (Timeout/Crash)" };
    } finally {
        activePins.delete(pin);
    }
}

// --- Scheduler ---
// Runs every minute to check if any medicine is scheduled to dispense
cron.schedule('* * * * *', async () => {
    const now = new Date();
    const currentTimeString = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
    const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const today = dayNames[now.getDay()];
    console.log(`[SCHEDULE CHECK] Current time: ${currentTimeString} (${today})`);
    const matchingSchedules = await db.all('SELECT * FROM schedules WHERE time = ?', currentTimeString);
    for (const schedule of matchingSchedules) {
        if (schedule.schedule_type === 'prn') continue;
        const days = schedule.days || 'daily';
        if (days !== 'daily') {
            const allowedDays = days.split(',').map(d => d.trim());
            if (!allowedDays.includes(today)) continue;
        }
        console.log(`\n========================================================================`);
        console.log(`[STEP 1/3: SCHEDULE QUEUED] Pin ${schedule.pin} is due! Dispense sequence started.`);
        console.log(`  - Step 1/3: Schedule Queued -> COMPLETE`);
        console.log(`  - Step 2/3: Registered Face Detection -> PENDING`);
        console.log(`  - Step 3/3: Ultrasonic Object Proximity (<= 20 inches / 50.8 cm) -> PENDING`);
        console.log(`  - Face Detected: NO | Object in Range: NO | Will Dispense Now?: NO (Waiting for registered face)`);
        console.log(`========================================================================\n`);
        pendingDispenseQueue.add(schedule.pin);

        // Reset face verification state so each queued schedule requires fresh face verification
        isFaceVerified = false;
        verifiedFaceName = null;
        faceVerifiedTime = null;
        lastUltrasonicEvent = null;

        // Activate direct webcam stream and start face prediction on-demand
        startCameraService();
        startStatusLogger();

        // Start 3-minute timer: if no face detected & distance ranged within 3 min, consider missed and save to DB
        if (pendingScheduleTimers.has(schedule.pin)) {
            clearTimeout(pendingScheduleTimers.get(schedule.pin).timer);
        }
        const missedTimer = setTimeout(() => {
            handleMissedSchedule(schedule.pin);
        }, SCHEDULE_MISSED_TIMEOUT_MS);
        pendingScheduleTimers.set(schedule.pin, { timer: missedTimer, queuedAt: Date.now() });

        // Tell the ESP32 to start buzzing
        try {
            console.log(`[INFO] Sending command to Ultrasonic ESP32 to start buzzer...`);
            axios.get(`${ULTRASONIC_ESP32_URL}/buzzer/start`, { timeout: 5000 }).catch(err => {
                console.error(`[ERROR] Failed to reach Ultrasonic ESP32:`, err.message);
            });
        } catch (e) {
            console.error(`[ERROR] Exception trying to start buzzer:`, e.message);
        }
    }
});

// --- API Endpoints for Dispensing Pipeline ---

// 0. Stage 1 -> Stage 2: Face Verification
// Called by local_server.py when a registered face is detected
app.post('/api/verify-face', async (req, res) => {
    const { name, confidence } = req.body || {};

    // RULE 1: The system must NOT save the face detected if there is no schedule that is up now
    if (pendingDispenseQueue.size === 0) {
        console.log(`\n========================================================================`);
        console.log(`[ORDER ENFORCEMENT - FACE NOT SAVED] Face '${name || "Unknown"}' seen, but NO schedule is up right now!`);
        console.log(`  - Current State: IDLE (No schedule queued)`);
        console.log(`  - Face Detected: '${name || "Unknown"}'`);
        console.log(`  - Will Dispense Now?: NO! (No active schedule)`);
        console.log(`  - Rule Applied: Face detection is NOT saved.`);
        console.log(`========================================================================\n`);
        return res.status(400).json({
            success: false,
            saved: false,
            message: "No schedule is currently up. Face detection not saved."
        });
    }

    // RULE 2: Must be a registered face (not Unknown)
    if (!name || name === "Unknown") {
        console.log(`\n========================================================================`);
        console.log(`[ORDER ENFORCEMENT - UNREGISTERED FACE] Face detected, but person is NOT registered (Unknown)!`);
        console.log(`  - Current Step: [STEP 1/3: WAITING_FOR_FACE]`);
        console.log(`  - Face Detected: YES (Unregistered / Unknown)`);
        console.log(`  - Will Dispense Now?: NO! (Only registered patient faces can authorize dispense)`);
        console.log(`========================================================================\n`);
        return res.status(403).json({
            success: false,
            saved: false,
            message: "Face is not registered. Registered face required."
        });
    }

    // A schedule is up and face is registered! Advance to Step 2
    isFaceVerified = true;
    verifiedFaceName = name;
    faceVerifiedTime = Date.now();

    // Notify Ultrasonic ESP32 that registered face has been detected and verified!
    notifyUltrasonicFaceVerified(name);

    console.log(`\n========================================================================`);
    console.log(`[STEP 2/3: FACE DETECTED & VERIFIED] Registered face '${name}' confirmed!`);
    console.log(`  - Step 1/3: Schedule Queued -> COMPLETE`);
    console.log(`  - Step 2/3: Registered Face Detection ('${name}') -> COMPLETE (Face saved)`);
    console.log(`  - Step 3/3: Ultrasonic Object Proximity (<= 20 inches / 50.8 cm) -> PENDING`);
    console.log(`  - Face Detected: YES ('${name}') | Object in Range: NO | Will Dispense Now?: NO (Waiting for ultrasonic object detection)`);
    console.log(`========================================================================\n`);

    // Face verified: stop camera prediction process and release webcam
    stopCameraService();

    return res.json({
        success: true,
        saved: true,
        message: `Face '${name}' verified. Waiting for ultrasonic sensor within 20 inches (50.8 cm)...`,
        name,
        queuedPins: Array.from(pendingDispenseQueue)
    });
});

// Legacy / Backwards compatibility endpoint
app.post('/api/trigger-queued-dispense', async (req, res) => {
    const { name } = req.body || {};
    if (pendingDispenseQueue.size === 0) {
        return res.status(400).json({ success: false, saved: false, message: "No schedule is currently up. Face detection not saved." });
    }
    if (!name || name === "Unknown") {
        return res.status(403).json({ success: false, saved: false, message: "Face is not registered. Registered face required." });
    }
    isFaceVerified = true;
    verifiedFaceName = name;
    faceVerifiedTime = Date.now();
    notifyUltrasonicFaceVerified(name);
    return res.json({ success: true, saved: true, message: `Face '${name}' verified. Waiting for ultrasonic sensor within 20 inches (50.8 cm)...` });
});

// Stage 2 -> Stage 3: Ultrasonic Proximity Trigger & Dispense Activation
// Called by ESP32 when Ultrasonic sensor detects an object within 20 inches (~50.8 cm)
app.post('/api/trigger-ultrasonic', async (req, res) => {
    const { distance, distance_unit } = req.body || {};
    const distText = distance !== undefined ? `${distance} ${distance_unit || 'cm'}` : "within 20 inches (50.8 cm)";

    // 1. Condition: Is any schedule currently up/queued?
    if (pendingDispenseQueue.size === 0) {
        console.log(`\n========================================================================`);
        console.log(`[ULTRASONIC IGNORED] Object detected at ${distText}, but NO schedule is currently up/queued!`);
        console.log(`  - System State: IDLE`);
        console.log(`  - Will Dispense Now?: NO (No active schedule)`);
        console.log(`========================================================================\n`);
        return res.status(400).json({ success: false, ignored: true, message: "No queued dispenses waiting" });
    }

    // 2. Condition: Check if face verification timed out
    if (faceVerifiedTime && (Date.now() - faceVerifiedTime > FACE_VERIFICATION_TIMEOUT_MS)) {
        console.log(`[FACE EXPIRED] Face verification timed out (> ${FACE_VERIFICATION_TIMEOUT_MS / 1000}s). Resetting face status.`);
        isFaceVerified = false;
        verifiedFaceName = null;
        faceVerifiedTime = null;
        notifyUltrasonicFaceReset();
    }

    // 3. Condition: MUST have registered face detected first!
    // STRICT ORDER ENFORCEMENT: Completely ignore ultrasonic object if face has not been verified yet!
    if (!isFaceVerified) {
        console.log(`\n========================================================================`);
        console.log(`[ORDER ENFORCEMENT - ULTRASONIC IGNORED] Object near sensor at ${distText} IGNORED!`);
        console.log(`  - Reason: A registered face has NOT been detected yet!`);
        console.log(`  - Step 1/3: Schedule Queued -> COMPLETE`);
        console.log(`  - Step 2/3: Registered Face Detection -> PENDING (MUST DETECT REGISTERED FACE FIRST)`);
        console.log(`  - Step 3/3: Ultrasonic Object Proximity (${distText}) -> IGNORED`);
        console.log(`  - Buzzer Status: KEEPS BUZZING (Ensuring buzzer stays active on ESP32)`);
        console.log(`  - Dispenser: WILL NOT DISPENSE (Order strictly enforced)`);
        console.log(`========================================================================\n`);

        // Fail-safe: Re-assert that the buzzer must stay buzzing on the Ultrasonic ESP32
        try {
            axios.get(`${ULTRASONIC_ESP32_URL}/buzzer/start`, { timeout: 3000 }).catch(() => {});
        } catch (e) {}

        return res.status(403).json({
            success: false,
            ignored: true,
            message: "Dispense blocked: A registered face must be detected first before ultrasonic sensor can activate dispense."
        });
    }

    // 4. All conditions satisfied: Schedule is up + Registered face verified + Ultrasonic triggered within range!
    // ONLY update lastUltrasonicEvent when face is verified so monitors don't see premature triggers!
    lastUltrasonicEvent = {
        time: new Date().toLocaleTimeString(),
        distance: distance !== undefined ? Number(distance) : null,
        distanceText: distText,
        stateAtTrigger: "WAITING_FOR_ULTRASONIC"
    };

    console.log(`\n========================================================================`);
    console.log(`[STEP 3/3: ULTRASONIC SENSOR CONFIRMED] Hand/Object detected by sensor at ${distText}!`);
    console.log(`  - Status: AUTHORIZED! Registered face confirmed ('${verifiedFaceName}') AND Hand/Object detected in range!`);
    console.log(`  - Step 1/3: Schedule Queued -> COMPLETE`);
    console.log(`  - Step 2/3: Registered Face Detection ('${verifiedFaceName}') -> COMPLETE`);
    console.log(`  - Step 3/3: Ultrasonic Object Proximity (${distText}) -> COMPLETE`);
    console.log(`  - Will Dispense Now?: YES! DISPENSING NOW!`);
    console.log(`  - Buzzer: STOPPING BUZZER! (Medicine is dispensing)`);
    console.log(`========================================================================\n`);

    // Stop buzzer on Ultrasonic ESP32 ONLY NOW because device is actively dispensing
    try {
        console.log(`[BUZZER] Dispense confirmed. Sending command to Ultrasonic ESP32 to stop buzzer...`);
        axios.get(`${ULTRASONIC_ESP32_URL}/buzzer/stop`, { timeout: 3000 }).catch(() => {});
    } catch (e) {}

    const results = [];
    const pinsToDispense = Array.from(pendingDispenseQueue);

    // Clear queue and state immediately to prevent duplicate dispensing
    pendingDispenseQueue.clear();
    isFaceVerified = false;
    const dispensingFace = verifiedFaceName;
    verifiedFaceName = null;
    faceVerifiedTime = null;

    // Release camera process if still active
    stopCameraService();
    stopStatusLogger();

    for (const pin of pinsToDispense) {
        // Cancel active 3-minute missed timer since medicine was successfully dispensed
        if (pendingScheduleTimers.has(pin)) {
            clearTimeout(pendingScheduleTimers.get(pin).timer);
            pendingScheduleTimers.delete(pin);
        }

        const result = await dispenseMedicine(pin, dispensingFace);
        results.push({ pin, ...result });
    }

    res.json({ success: true, message: "Dispensed successfully", results, dispensedTo: dispensingFace });
});

// 0.5 Trigger the pump for a specific duration
app.post('/api/pump', async (req, res) => {
    const { ms } = req.body;
    const duration = parseInt(ms, 10);
    
    if (isNaN(duration) || duration <= 0) {
        return res.status(400).json({ success: false, message: "Invalid ms parameter" });
    }

    try {
        console.log(`[INFO] API requested to start pump for ${duration} ms`);
        await axios.get(`${ULTRASONIC_ESP32_URL}/relay/pump?ms=${duration}`, { timeout: 5000 });
        
        res.json({ success: true, message: `Pump started for ${duration}ms` });
    } catch (error) {
        console.error(`[ERROR] Failed to start pump: ${error.message}`);
        res.status(500).json({ success: false, message: "Failed to communicate with ESP32" });
    }
});

// 1. Get the current status of all tiles, their schedules, and the dispense state
app.get('/api/status', async (req, res) => {
    const tiles = await db.all('SELECT * FROM tiles');
    const schedules = await db.all('SELECT * FROM schedules');
    const responseData = tiles.map(tile => {
        return {
            ...tile,
            schedules: schedules.filter(s => s.pin === tile.pin)
        };
    });

    const currentStep = pendingDispenseQueue.size === 0
        ? "IDLE"
        : (!isFaceVerified ? "WAITING_FOR_FACE" : "WAITING_FOR_ULTRASONIC");

    const activeTimeouts = Array.from(pendingScheduleTimers.entries()).map(([pin, info]) => {
        const elapsed = Date.now() - info.queuedAt;
        const remainingMs = Math.max(0, SCHEDULE_MISSED_TIMEOUT_MS - elapsed);
        return {
            pin,
            queuedAt: info.queuedAt,
            elapsedSeconds: Math.floor(elapsed / 1000),
            remainingSeconds: Math.ceil(remainingMs / 1000)
        };
    });

    res.json({
        success: true,
        data: responseData,
        systemState: {
            step: currentStep,
            pendingQueue: Array.from(pendingDispenseQueue),
            isFaceVerified,
            verifiedFaceName,
            activeTimeouts,
            lastUltrasonicEvent
        }
    });
});

// 2. Add/Update Medicine on a Tile (Select Tile by Pin)
app.post('/api/update-medicine', async (req, res) => {
    const { pin, name, count } = req.body;
    // Allow Pin 13 (liquid pump)
    if (!AVAILABLE_PINS.includes(Number(pin)) && Number(pin) !== 13) {
        return res.status(400).json({ success: false, message: "Invalid tile pin" });
    }
    
    if (name === "Empty") {
        await db.run('UPDATE tiles SET medicine_name = ?, count = 0, current_degree = 0 WHERE pin = ?', ["Empty", pin]);
        // When setting to empty, also clear all schedules for this pin
        await db.run('DELETE FROM schedules WHERE pin = ?', [pin]);
        // Also ensure the servo goes back to 0 degrees if it's a solid tile
        if (Number(pin) !== 13) {
            axios.get(`${ESP32_BASE_URL}/spin?pin=${pin}&degree=0`).catch(()=>{});
        }
    } else {
        // If a count is provided, use it. Otherwise default to 9.
        const startCount = count !== undefined ? parseInt(count) : 9;
        
        // Ensure tile exists (for pin 13 which isn't in default AVAILABLE_PINS)
        const existing = await db.get('SELECT pin FROM tiles WHERE pin = ?', pin);
        if (!existing) {
            await db.run('INSERT INTO tiles (pin, medicine_name, count) VALUES (?, ?, ?)', [pin, name, startCount]);
        } else {
            await db.run('UPDATE tiles SET medicine_name = ?, count = ? WHERE pin = ?', [name, startCount, pin]);
        }
    }

    const updatedTile = await db.get('SELECT * FROM tiles WHERE pin = ?', pin);
    res.json({ success: true, message: `Tile ${pin} updated`, data: updatedTile });
});

// 3. Add a time schedule for a specific tile/pin
app.post('/api/schedule', async (req, res) => {
    const { pin, time, schedule_type, days, med_type, amount, ms } = req.body;
    
    // We allow pin 13 for liquid pump scheduling
    if (!AVAILABLE_PINS.includes(Number(pin)) && Number(pin) !== 13) {
        return res.status(400).json({ success: false, message: "Invalid tile pin" });
    }
    const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;
    if (!timeRegex.test(time)) {
        return res.status(400).json({ success: false, message: "Invalid time format (HH:MM)" });
    }
    const sType = schedule_type || 'once_daily';
    const sDays = days || 'daily';
    const sMedType = med_type || 'solid';
    const sAmount = amount || 1;
    const sMs = ms || 0;
    
    const existing = await db.get('SELECT id FROM schedules WHERE pin = ? AND time = ?', [pin, time]);
    if (!existing) {
        await db.run(
            'INSERT INTO schedules (pin, time, schedule_type, days, med_type, amount, ms) VALUES (?, ?, ?, ?, ?, ?, ?)', 
            [pin, time, sType, sDays, sMedType, sAmount, sMs]
        );
    }
    res.json({ success: true, message: `Schedule ${time} added to tile ${pin}` });
});

// 4. Remove a schedule
app.post('/api/remove-schedule', async (req, res) => {
    const { pin, time } = req.body;
    await db.run('DELETE FROM schedules WHERE pin = ? AND time = ?', [pin, time]);
    res.json({ success: true, message: `Schedule ${time} removed from tile ${pin}` });
});

// 5. Refill the medicine tile (Resets count to 9)
app.post('/api/refill', async (req, res) => {
    const { pin } = req.body;
    if (!AVAILABLE_PINS.includes(Number(pin))) {
        return res.status(400).json({ success: false, message: "Invalid tile pin" });
    }

    await db.run('UPDATE tiles SET count = 5, current_degree = 0 WHERE pin = ?', [pin]);
    if (Number(pin) !== 13) {
        axios.get(`${ESP32_BASE_URL}/spin?pin=${pin}&degree=0`).catch(()=>{});
    }
    res.json({ success: true, message: `Tile ${pin} refilled to 5 and reset to 0 degrees!` });
});

// 6. Manually update the medicine count for a tile
app.post('/api/update-count', async (req, res) => {
    const { pin, count } = req.body;

    if (!AVAILABLE_PINS.includes(Number(pin)) && Number(pin) !== 13) {
        return res.status(400).json({ success: false, message: "Invalid tile pin" });
    }

    const newCount = parseInt(count);
    if (isNaN(newCount) || newCount < 0 || (Number(pin) !== 13 && newCount > 99)) {
        return res.status(400).json({ success: false, message: "Invalid count amount" });
    }

    await db.run('UPDATE tiles SET count = ? WHERE pin = ?', [newCount, pin]);
    const updated = await db.get('SELECT * FROM tiles WHERE pin = ?', pin);
    console.log(`[INFO] Count for Tile (Pin ${pin}) manually updated to ${newCount}`);
    res.json({ success: true, data: updated });
});

// 7. Manual Override to Dispense immediately
app.post('/api/dispense', async (req, res) => {
    const { pin } = req.body;
    if (!AVAILABLE_PINS.includes(Number(pin)) && Number(pin) !== 13) {
        return res.status(400).json({ success: false, message: "Invalid tile pin" });
    }

    const result = await dispenseMedicine(pin);
    if (result.success) {
        res.json(result);
    } else {
        res.status(500).json(result);
    }
});

// 8. Get dispense history — optionally filter by date (YYYY-MM-DD)
app.get('/api/history', async (req, res) => {
    const { date } = req.query;
    let rows;
    if (date) {
        // Filter by date portion of dispensed_at
        rows = await db.all(
            `SELECT * FROM dispense_history WHERE date(dispensed_at) = ? ORDER BY dispensed_at DESC`,
            [date]
        );
    } else {
        rows = await db.all(
            `SELECT * FROM dispense_history ORDER BY dispensed_at DESC LIMIT 100`
        );
    }
    res.json({ success: true, data: rows });
});

// 9. Testing helper: Manually trigger a schedule queue for testing the pipeline
app.post('/api/test/queue-schedule', async (req, res) => {
    const { pin, timeoutMs } = req.body || {};
    const targetPin = pin ? Number(pin) : 19;
    pendingDispenseQueue.add(targetPin);
    isFaceVerified = false;
    verifiedFaceName = null;
    faceVerifiedTime = null;
    lastUltrasonicEvent = null;

    if (pendingScheduleTimers.has(targetPin)) {
        clearTimeout(pendingScheduleTimers.get(targetPin).timer);
    }
    const duration = timeoutMs !== undefined ? Number(timeoutMs) : SCHEDULE_MISSED_TIMEOUT_MS;
    const timer = setTimeout(() => {
        handleMissedSchedule(targetPin);
    }, duration);
    pendingScheduleTimers.set(targetPin, { timer, queuedAt: Date.now() });

    console.log(`\n========================================================================`);
    console.log(`[STEP 1/3: SCHEDULE QUEUED (TEST)] Pin ${targetPin} manually queued! (Timeout: ${duration / 1000}s)`);
    console.log(`  - Step 1/3: Schedule Queued -> COMPLETE`);
    console.log(`  - Step 2/3: Registered Face Detection -> PENDING`);
    console.log(`  - Step 3/3: Ultrasonic Object Proximity (<= 20 inches / 50.8 cm) -> PENDING`);
    console.log(`  - Face Detected: NO | Object in Range: NO | Will Dispense Now?: NO (Waiting for registered face)`);
    console.log(`========================================================================\n`);
    
    // Activate direct webcam stream & face prediction on-demand
    startCameraService();
    startStatusLogger();

    // Tell the ESP32 to start buzzing
    try {
        console.log(`[INFO] Sending command to Ultrasonic ESP32 to start buzzer...`);
        axios.get(`${ULTRASONIC_ESP32_URL}/buzzer/start`, { timeout: 5000 }).catch(err => {
            console.error(`[ERROR] Failed to reach Ultrasonic ESP32:`, err.message);
        });
    } catch (e) {
        console.error(`[ERROR] Exception trying to start buzzer:`, e.message);
    }

    res.json({
        success: true,
        message: `Pin ${targetPin} manually queued. Timeout in ${duration / 1000}s. State: WAITING_FOR_FACE`,
        queuedPins: Array.from(pendingDispenseQueue),
        timeoutMs: duration
    });
});

// 10. Testing helper: Reset pending queue and verification states
app.post('/api/test/reset-state', (req, res) => {
    for (const [pin, obj] of pendingScheduleTimers.entries()) {
        clearTimeout(obj.timer);
    }
    pendingScheduleTimers.clear();
    pendingDispenseQueue.clear();
    isFaceVerified = false;
    verifiedFaceName = null;
    faceVerifiedTime = null;
    lastUltrasonicEvent = null;

    try {
        axios.get(`${ULTRASONIC_ESP32_URL}/buzzer/stop`, { timeout: 3000 }).catch(() => {});
        notifyUltrasonicFaceReset();
    } catch (e) {}

    // Release camera process and status logger if running
    stopCameraService();
    stopStatusLogger();

    console.log(`\n[TEST] System state reset to IDLE.\n`);
    res.json({ success: true, message: "System state reset to IDLE." });
});

// --- Camera Service Process Manager ---
const AUTO_START_CAMERA = process.env.AUTO_START_CAMERA !== 'false'; // Auto-start camera by default
const CAMERA_MODE = process.env.CAMERA_MODE || 'terminal'; // 'terminal' (detect_face_terminal.py), 'webcam', or 'esp32'
const CAMERA_INDEX = process.env.CAMERA_INDEX || '0'; // MWB-15 external webcam is likely index 0 here
const PYTHON_PATH = process.env.PYTHON_PATH || 'C:\\Users\\ferna\\AppData\\Local\\Programs\\Python\\Python314\\python.exe';

let cameraProcess = null;

function startCameraService() {
    if (cameraProcess) {
        return { success: true, message: "Camera process is already running" };
    }

    let scriptCwd;
    let spawnArgs = ['-u'];

    if (CAMERA_MODE === 'esp32') {
        scriptCwd = path.resolve(__dirname, '..', 'localStreamCamera');
        spawnArgs.push('local_server.py');
    } else if (CAMERA_MODE === 'webcam') {
        scriptCwd = path.resolve(__dirname, '..', 'localStreamCamera');
        spawnArgs.push('webcam_face_recognition.py');
    } else {
        // Default: Use detect_face_terminal.py with external webcam (cam 1) and exit on verify
        scriptCwd = path.resolve(__dirname, '..');
        const scriptPath = path.resolve(scriptCwd, 'detect_face_terminal.py');
        spawnArgs.push(scriptPath, '--cam', String(CAMERA_INDEX), '--exit-on-verify');
    }

    console.log(`[CAMERA] Starting face recognition service with detect_face_terminal.py (cam: ${CAMERA_INDEX})...`);
    try {
        cameraProcess = spawn(PYTHON_PATH, spawnArgs, {
            cwd: scriptCwd,
            stdio: ['ignore', 'pipe', 'pipe']
        });

        cameraProcess.stdout.on('data', (data) => {
            const lines = data.toString().trim().split('\n');
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                console.log(`[FACE CAM] ${trimmed}`);

                // Direct stdout fallback: ONLY trigger when detect_face_terminal.py confirms stable multi-frame match
                // Example line: [22:40:15] [FACE VERIFIED] Confirmed: Me | Stable across 3 frames
                const matchRegex = /\[FACE VERIFIED\]\s+Confirmed:\s+([A-Za-z0-9_\-]+)/i;
                const match = trimmed.match(matchRegex);
                if (match && match[1] && pendingDispenseQueue.size > 0 && !isFaceVerified) {
                    const detectedName = match[1];
                    if (detectedName !== 'Unknown') {
                        isFaceVerified = true;
                        verifiedFaceName = detectedName;
                        faceVerifiedTime = Date.now();
                        notifyUltrasonicFaceVerified(detectedName);
                        console.log(`\n========================================================================`);
                        console.log(`[STEP 2/3: FACE DETECTED & VERIFIED] Registered face '${detectedName}' confirmed from camera stream!`);
                        console.log(`  - Step 1/3: Schedule Queued -> COMPLETE`);
                        console.log(`  - Step 2/3: Registered Face Detection ('${detectedName}') -> COMPLETE (Face saved)`);
                        console.log(`  - Step 3/3: Ultrasonic Object Proximity (<= 20 inches / 50.8 cm) -> PENDING`);
                        console.log(`  - Face Detected: YES ('${detectedName}') | Object in Range: NO | Will Dispense Now?: NO (Waiting for ultrasonic object detection)`);
                        console.log(`========================================================================\n`);
                        stopCameraService();
                    }
                }
            }
        });

        cameraProcess.stderr.on('data', (data) => {
            const lines = data.toString().trim().split('\n');
            for (const line of lines) {
                const text = line.trim();
                if (text && !text.includes('WARN:0@') && !text.includes('Targets are not supported')) {
                    console.error(`[FACE CAM ERR] ${text}`);
                }
            }
        });

        cameraProcess.on('exit', (code) => {
            console.log(`[CAMERA] Face recognition camera process stopped (exit code: ${code}).`);
            cameraProcess = null;
        });

        cameraProcess.on('error', (err) => {
            console.warn(`[CAMERA WARNING] Could not auto-launch camera (${err.message}). Run: python detect_face_terminal.py --cam ${CAMERA_INDEX}`);
            cameraProcess = null;
        });

        return { success: true, message: `Camera service started (detect_face_terminal.py, cam: ${CAMERA_INDEX})` };
    } catch (e) {
        console.warn(`[CAMERA WARNING] Auto-launch failed: ${e.message}`);
        return { success: false, message: e.message };
    }
}

function stopCameraService() {
    if (cameraProcess) {
        console.log('[CAMERA] Stopping camera prediction service and releasing webcam stream...');
        try {
            const pid = cameraProcess.pid;
            cameraProcess.kill();
            cameraProcess = null;
            if (process.platform === 'win32' && pid) {
                spawn('taskkill', ['/pid', String(pid), '/f', '/t']).on('error', () => {});
            }
        } catch (e) {
            cameraProcess = null;
        }
        return { success: true, message: "Camera process stopped and webcam released." };
    }
    return { success: true, message: "Camera process was not running." };
}

// 11. Camera Control Endpoints
app.post('/api/camera/start', (req, res) => {
    const result = startCameraService();
    res.json(result);
});

app.post('/api/camera/stop', (req, res) => {
    const result = stopCameraService();
    res.json(result);
});

app.get('/api/camera/status', (req, res) => {
    res.json({
        success: true,
        running: cameraProcess !== null,
        mode: CAMERA_MODE,
        autoStart: AUTO_START_CAMERA
    });
});

// Process cleanup on exit
function cleanup() {
    if (cameraProcess) {
        try {
            cameraProcess.kill();
            cameraProcess = null;
        } catch (e) {}
    }
}
process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });
process.on('exit', () => { cleanup(); });

// Start the server and initialize DB
initDB().then(() => {
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`===========================================`);
        console.log(`💊 AlertMed API Server (SQLite) is running on port ${PORT}`);
        console.log(`📹 Face prediction activates automatically when a schedule is up`);
        console.log(`===========================================`);
    });
});
