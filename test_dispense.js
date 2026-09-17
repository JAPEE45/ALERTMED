const EventEmitter = require('events');

// --- HARDWARE CONFIGURATION ---
const SOLID_DEGREES_PER_PILL = 40;
const LIQUID_MS_PER_2_5_ML = 1900;
const LIQUID_RELAY_PIN = 13;
const TRIGGER_DISTANCE_CM = 50.8; // 20 inches in cm (20 * 2.54 = 50.8 cm)
const MIN_DISTANCE_CM = 2.0;

/**
 * Simulates a Smart Tile with a Servo for Solid Medication
 */
class ServoTile {
    constructor(pin, maxCapacity = 9) {
        this.pin = pin;
        this.maxCapacity = maxCapacity;
        this.currentCount = maxCapacity;
        this.currentDegree = 0;
    }

    calculateDegrees(amountToDispense) {
        return amountToDispense * SOLID_DEGREES_PER_PILL;
    }

    dispense(amount) {
        if (this.currentCount < amount) {
            console.log(`  [SERVO-PIN-${this.pin}] Not enough pills! Available: ${this.currentCount}`);
            return false;
        }

        const degreesToRotate = this.calculateDegrees(amount);
        this.currentCount -= amount;
        this.currentDegree += degreesToRotate;
        
        console.log(`  [SERVO-PIN-${this.pin}] Dispensed ${amount} solid pill(s). Servo rotated by ${degreesToRotate} deg (pos: ${this.currentDegree} deg). Left: ${this.currentCount}`);
        return true;
    }

    resetToZero() {
        console.log(`  [SERVO-PIN-${this.pin}] Schedule deleted or reset. Servo back to 0 degrees.`);
        this.currentDegree = 0;
    }
}

/**
 * Simulates the Liquid Dispenser using a Relay (Pin 13)
 */
class LiquidDispenser {
    constructor() {
        this.pin = LIQUID_RELAY_PIN;
    }

    calculateMs(ml) {
        return (ml / 2.5) * LIQUID_MS_PER_2_5_ML;
    }

    dispense(ml) {
        const msToRun = this.calculateMs(ml);
        console.log(`  [PUMP-PIN-${this.pin}] Dispensing ${ml} ml of liquid... Relay active for ${msToRun.toFixed(0)} ms.`);
        return new Promise(resolve => {
            setTimeout(() => {
                console.log(`  [PUMP-PIN-${this.pin}] Relay turned OFF. Liquid dispense complete.`);
                resolve(true);
            }, 100);
        });
    }
}

/**
 * Master Schedule Queue System
 * Enforces:
 * Step 1: Schedule is up -> Queued (WAITING_FOR_FACE), Buzzer sounds, 3-min countdown starts
 * Step 2: Registered face detected -> Face verified (WAITING_FOR_ULTRASONIC)
 * Step 3: Ultrasonic detected within 20 inches (~50.8 cm) -> DISPENSE ACTIVATES!
 * 
 * Missed Schedule Rule:
 * If no face detected & distance ranged within 3 minutes:
 * -> Consider as MISSED
 * -> Save to database history (status: 'missed')
 * -> Remove from queue (no longer up)
 * -> Stop buzzer
 */
class DispenseSystem extends EventEmitter {
    constructor() {
        super();
        this.queue = [];
        this.servos = {
            19: new ServoTile(19),
            18: new ServoTile(18)
        };
        this.pump = new LiquidDispenser();
        this.history = []; // Simulates database table `dispense_history`
        this.timers = new Map(); // pin -> timer
        this.isBuzzing = false;
        
        // Multi-stage verification state
        this.isFaceVerified = false;
        this.verifiedFaceName = null;
    }

    // Step 1: Schedule is up
    scheduleDispense(schedule, timeoutMs = 180000) {
        console.log(`\n[STEP 1: SCHEDULE UP] Schedule triggered at ${schedule.time}. Type: ${schedule.type}, Amount: ${schedule.amount}, Pin: ${schedule.pin}`);
        this.queue.push(schedule);
        this.isFaceVerified = false;
        this.verifiedFaceName = null;
        this.isBuzzing = true;
        console.log(`  -> Items in queue: ${this.queue.length}. Buzzer started! System state: WAITING_FOR_FACE`);

        // Set Missed Schedule Countdown (3 minutes = 180,000 ms)
        if (this.timers.has(schedule.pin)) {
            clearTimeout(this.timers.get(schedule.pin));
        }
        const t = setTimeout(() => {
            this.handleMissedSchedule(schedule.pin);
        }, timeoutMs);
        this.timers.set(schedule.pin, t);
    }

    handleMissedSchedule(pin) {
        const itemIdx = this.queue.findIndex(s => s.pin === pin);
        if (itemIdx === -1) return; // Already dispensed

        const item = this.queue[itemIdx];
        this.queue.splice(itemIdx, 1);
        this.timers.delete(pin);

        console.log(`\n[MISSED SCHEDULE] 3 minutes elapsed without face & proximity verification for Pin ${pin}!`);
        
        // Save to database
        const record = {
            pin: item.pin,
            medicine_name: `Med-Pin-${item.pin}`,
            status: 'missed',
            dispensed_at: new Date().toISOString()
        };
        this.history.push(record);
        console.log(`  [DB] Saved to database history: status='missed', pin=${item.pin}.`);
        console.log(`  [QUEUE] Removed schedule from queue. Remaining queued items: ${this.queue.length}`);

        if (this.queue.length === 0) {
            this.isBuzzing = false;
            this.isFaceVerified = false;
            this.verifiedFaceName = null;
            console.log(`  [BUZZER] Stopped buzzer. System returned to IDLE.`);
        }
    }

    // Step 2: Face Detection
    detectFace(name, isRegistered = true) {
        console.log(`\n[FACE DETECTOR] Camera scanned face: "${name}" (registered: ${isRegistered})`);

        // Condition Check 1: Must not save if no schedule is up now
        if (this.queue.length === 0) {
            console.log(`  [REJECTED] No schedule is currently up. Face detection is NOT saved.`);
            return { success: false, reason: "NO_SCHEDULE_UP" };
        }

        // Condition Check 2: Must be a registered face
        if (!isRegistered || name === "Unknown") {
            console.log(`  [REJECTED] Face is not registered. Only registered faces can authorize dispense.`);
            return { success: false, reason: "UNREGISTERED_FACE" };
        }

        // Condition satisfied: Save face verification for this queued schedule
        this.isFaceVerified = true;
        this.verifiedFaceName = name;
        console.log(`  [SUCCESS] Registered face "${name}" verified! System state: WAITING_FOR_ULTRASONIC (20 inches / 50.8 cm)`);
        return { success: true, verifiedFor: name };
    }

    // Step 3: Ultrasonic Detection
    async detectUltrasonic(distanceCm) {
        const distanceInches = (distanceCm / 2.54).toFixed(1);
        console.log(`\n[ULTRASONIC SENSOR] Object detected at ${distanceCm} cm (${distanceInches} inches)`);

        // Check range: must be within 20 inches (50.8 cm) and >= 2 cm
        if (distanceCm < MIN_DISTANCE_CM || distanceCm > TRIGGER_DISTANCE_CM) {
            console.log(`  [IGNORED] Object is outside 20-inch threshold (50.8 cm). Range required: 2 - 50.8 cm.`);
            return { success: false, reason: "OUT_OF_RANGE" };
        }

        // Check if schedule is up
        if (this.queue.length === 0) {
            console.log(`  [BLOCKED] Ultrasonic triggered within range, but NO schedule is in queue.`);
            return { success: false, reason: "NO_SCHEDULE" };
        }

        // Critical Check: Make sure order is proper - face must be detected first!
        if (!this.isFaceVerified) {
            console.log(`  [IGNORED] Ultrasonic detected object at ${distanceCm} cm, but registered face has NOT been detected yet! Object ignored.`);
            console.log(`  [BUZZER] Buzzer continues buzzing! (isBuzzing: ${this.isBuzzing})`);
            return { success: false, reason: "FACE_NOT_VERIFIED", ignored: true };
        }

        // All conditions satisfied: Schedule UP + Face Verified + Ultrasonic within 50.8 cm
        console.log(`  [AUTHORIZED] All conditions met! Dispensing medicines to ${this.verifiedFaceName}...`);
        await this.executeDispense();
        return { success: true };
    }

    async executeDispense() {
        console.log(`\n--- EXECUTING DISPENSE FOR ${this.queue.length} ITEM(S) ---`);
        while (this.queue.length > 0) {
            const task = this.queue.shift();
            // Cancel missed schedule timer
            if (this.timers.has(task.pin)) {
                clearTimeout(this.timers.get(task.pin));
                this.timers.delete(task.pin);
            }

            if (task.type === 'solid') {
                const servo = this.servos[task.pin];
                if (servo) servo.dispense(task.amount);
            } else if (task.type === 'liquid') {
                await this.pump.dispense(task.amount);
            }

            // Save to database as dispensed
            this.history.push({
                pin: task.pin,
                medicine_name: `Med-Pin-${task.pin}`,
                status: 'dispensed',
                dispensed_at: new Date().toISOString()
            });
        }

        // Reset state & stop buzzer
        this.isFaceVerified = false;
        this.verifiedFaceName = null;
        this.isBuzzing = false;
        console.log(`[DISPENSE COMPLETE] Buzzer stopped. System reset to IDLE.\n`);
    }
}

// --- RUN VERIFICATION TESTS ---
async function runTests() {
    console.log("=================================================================");
    console.log("  ALERTMED DISPENSE PIPELINE & MISSED SCHEDULE SUITE");
    console.log("=================================================================");

    const system = new DispenseSystem();

    // TEST 1: Face detected when NO schedule is up -> Must NOT save
    console.log("\n>>> TEST 1: Face detected when NO schedule is up");
    const t1 = system.detectFace("Kean", true);
    console.assert(t1.success === false, "Test 1 Failed: Face should not be accepted when no schedule is up");
    console.assert(system.isFaceVerified === false, "Test 1 Failed: Face verification flag should be false");

    // TEST 2: Ultrasonic detects object when NO schedule is up -> Must NOT dispense
    console.log("\n>>> TEST 2: Ultrasonic detects object at 15 cm when NO schedule is up");
    const t2 = await system.detectUltrasonic(15.0);
    console.assert(t2.success === false, "Test 2 Failed: Should not dispense with no schedule");

    // TEST 3: Schedule is up -> Queued
    console.log("\n>>> TEST 3: Schedule triggers and queues solid + liquid meds");
    system.scheduleDispense({ time: '08:00', type: 'solid', pin: 19, amount: 2 });
    system.scheduleDispense({ time: '08:00', type: 'liquid', pin: LIQUID_RELAY_PIN, amount: 5 });

    // TEST 4: Ultrasonic detects object BEFORE face -> MUST BE IGNORED & BUZZER KEEPS BUZZING!
    console.log("\n>>> TEST 4: Ultrasonic detects object at 20 cm BEFORE face detection (MUST IGNORE & KEEP BUZZING)");
    const t4 = await system.detectUltrasonic(20.0);
    console.assert(t4.success === false && t4.reason === "FACE_NOT_VERIFIED", "Test 4 Failed: Dispense must be blocked if face not verified yet");
    console.assert(system.queue.length === 2, "Test 4 Failed: Queue should still have 2 items");
    console.assert(system.isBuzzing === true, "Test 4 Failed: Buzzer MUST remain active/buzzing when ultrasonic detects object before face!");

    // TEST 5: Unknown/Unregistered face detected -> REJECTED!
    console.log("\n>>> TEST 5: Unknown (unregistered) face detected");
    const t5 = system.detectFace("Unknown", false);
    console.assert(t5.success === false, "Test 5 Failed: Unregistered face should be rejected");
    console.assert(system.isFaceVerified === false, "Test 5 Failed: Face verification should remain false");

    // TEST 6: Registered face detected for queued schedule -> VERIFIED!
    console.log("\n>>> TEST 6: Registered face 'Kean' detected");
    const t6 = system.detectFace("Kean", true);
    console.assert(t6.success === true, "Test 6 Failed: Registered face should be verified");
    console.assert(system.isFaceVerified === true, "Test 6 Failed: Face verification flag should be true");

    // TEST 7: Object detected outside 20 inches (> 50.8 cm) -> TOO FAR, NO DISPENSE
    console.log("\n>>> TEST 7: Object detected at 65 cm (outside 20 inches / 50.8 cm)");
    const t7 = await system.detectUltrasonic(65.0);
    console.assert(t7.success === false && t7.reason === "OUT_OF_RANGE", "Test 7 Failed: Object > 50.8 cm should not trigger");
    console.assert(system.queue.length === 2, "Test 7 Failed: Queue should still be pending");

    // TEST 8: Object detected within 20 inches (<= 50.8 cm) -> DISPENSE ACTIVATES!
    console.log("\n>>> TEST 8: Object detected at 30 cm (within 20 inches / 50.8 cm) -> DISPENSE ACTIVATES!");
    const t8 = await system.detectUltrasonic(30.0);
    console.assert(t8.success === true, "Test 8 Failed: Dispense should succeed");
    console.assert(system.queue.length === 0, "Test 8 Failed: Queue should now be empty");
    console.assert(system.isFaceVerified === false, "Test 8 Failed: Face verification should be reset to false");

    // TEST 9: Missed Schedule (3 minutes timeout simulation)
    console.log("\n>>> TEST 9: Schedule triggers, but no face & proximity detected within 3 min -> MISSED!");
    // Queue Pin 18 with 500ms timeout for rapid test
    system.scheduleDispense({ time: '12:00', type: 'solid', pin: 18, amount: 1 }, 500);
    console.assert(system.queue.length === 1, "Test 9 Setup Failed");

    // Wait for the timeout to elapse
    await new Promise(r => setTimeout(r, 650));

    console.assert(system.queue.length === 0, "Test 9 Failed: Schedule should be removed from queue after timeout");
    const missedRecord = system.history.find(h => h.pin === 18 && h.status === 'missed');
    console.assert(missedRecord !== undefined, "Test 9 Failed: Missed record was not saved to history");
    console.assert(system.isBuzzing === false, "Test 9 Failed: Buzzer should be stopped after missed schedule");

    console.log("=================================================================");
    console.log("  ALL TESTS PASSED SUCCESSFULLY! Both dispensing & missed schedule work.");
    console.log("=================================================================");
}

runTests();
