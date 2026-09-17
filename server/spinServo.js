const axios = require('axios');

const esp32Ip = 'http://10.180.37.20:8080'; // including port 8080

async function spinServo(pin, degree) {
    try {
        console.log(`Sending command to ESP32 at ${esp32Ip} to spin servo on pin ${pin} to ${degree} degrees over 1 second...`);
        const response = await axios.get(`${esp32Ip}/spin?pin=${pin}&degree=${degree}&duration=1000`);
        console.log(`Servo spin command sent successfully! Response:`, response.data);
    } catch (error) {
        console.error('Failed to send command to ESP32:');
        if (error.response) {
            console.error(`Status: ${error.response.status}`);
            console.error(`Data: ${error.response.data}`);
        } else {
            console.error(error.message);
        }
    }
}

// Get arguments from command line
const args = process.argv.slice(2);
if (args.length < 2) {
    console.log("Usage: node spinServo.js <pin> <degree>");
    console.log("Example: node spinServo.js 2 90");
    process.exit(1);
}

const pin = parseInt(args[0], 10);
const degree = parseInt(args[1], 10);

if (isNaN(pin) || isNaN(degree)) {
    console.log("Pin and degree must be valid numbers.");
    process.exit(1);
}

if (degree < 0 || degree > 180) {
    console.log("Degree must be between 0 and 180");
    process.exit(1);
}

spinServo(pin, degree);
