const axios = require('axios');

async function scanNetwork() {
    console.log("Checking if the ESP32 is online at all (Scanning Port 80 and 8080)...");
    
    const subnets = ['192.168.0', '192.168.1'];
    const promises = [];
    
    for (const subnet of subnets) {
        for(let i=1; i<255; i++) {
           promises.push(checkIpPort(`${subnet}.${i}`, 8080));
           promises.push(checkIpPort(`${subnet}.${i}`, 80));
        }
    }

    await Promise.allSettled(promises);
    console.log("Scan finished.");
}

async function checkIpPort(ip, port) {
    try {
        const res = await axios.get(`http://${ip}:${port}/`, { 
            timeout: 2500,
            validateStatus: () => true 
        });
        
        if (res.data && res.data.message === "Endpoint not found") {
            console.log(`\n🎉 FOUND NEW API CODE AT: ${ip}:${port}\n`);
            process.exit(0);
        } else if (typeof res.data === 'string' && res.data.includes("ESP32 Servo Control")) {
            console.log(`\n⚠️ FOUND OLD HTML CODE AT: ${ip}:${port}. You forgot to upload the new code to the ESP32 via Arduino IDE!\n`);
            process.exit(0);
        }
    } catch(e) {}
}

scanNetwork();
