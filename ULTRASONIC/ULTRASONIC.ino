#include <WiFi.h>
#include <HTTPClient.h>
#include <WebServer.h>
#include <ESP32Servo.h>

// Servo variables
Servo myServo;
int activeServoPin = -1;
bool isServoSpinning = false;
int startDegree = 0;
int targetDegree = 0;
unsigned long spinStartTime = 0;
unsigned long spinDuration = 1000;

const char* ssid = "J";
const char* password = "mamamo4545";

// --- Static IP Configuration ---
// Configured to end in .21 as required for the Ultrasonic ESP32
IPAddress local_IP(10, 180, 37, 21);
IPAddress gateway(10, 180, 37, 155);
IPAddress subnet(255, 255, 255, 0);
IPAddress primaryDNS(10, 180, 37, 155); 
IPAddress secondaryDNS(8, 8, 8, 8); 

// Node.js server address (Your computer's IP running index.js)
const char* serverUrl = "http://10.180.37.241:3000/api/trigger-ultrasonic"; 
// Create a web server on port 80 to receive commands from Node.js
WebServer server(80);

// Pins
const int trigPin = 5;
const int echoPin = 18;
const int buzzerPin = 4; // Add Piezo Buzzer to Pin D4
const int relayPin = 13; // 1-Channel Relay to Pin G13 (Changed from 12 to avoid boot issues)

// Distance threshold (20 inches converted to centimeters: 20 * 2.54 = 50.8 cm)
const float TRIGGER_DISTANCE_CM = 50.8;
const float MIN_DISTANCE_CM = 2.0;

// State Variables
bool isBuzzing = false;
unsigned long lastBeepTime = 0;
bool buzzerState = false;

// Step 2 Gate: Face Verification (Set to true ONLY when server reports a registered face is detected)
// If isFaceVerified is false, any object near ultrasonic sensor is COMPLETELY IGNORED!
bool isFaceVerified = false;
bool isSendingRequest = false; // Prevent multiple concurrent HTTP tasks

bool isPumping = false;
unsigned long pumpStartTime = 0;
unsigned long pumpDuration = 0;

bool isObjectPresent = false; // Tracks if an object is currently in front of the sensor (for the relay)

unsigned long lastSensorRead = 0;
unsigned long lastTriggerTime = 0;
const unsigned long COOLDOWN_MS = 5000; // 5 seconds cooldown after a trigger

void setup() {
  Serial.begin(115200);

  pinMode(trigPin, OUTPUT);
  pinMode(echoPin, INPUT);
  pinMode(buzzerPin, OUTPUT);
  digitalWrite(buzzerPin, LOW);
  
  pinMode(relayPin, OUTPUT);
  digitalWrite(relayPin, HIGH); // Default state when NO object is detected

  // --- WIFI FIXES ---
  WiFi.disconnect(true); // Clear old credentials and station state
  delay(500);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);

  // Apply Static IP (must be after mode(WIFI_STA) and before begin())
  if (!WiFi.config(local_IP, gateway, subnet, primaryDNS, secondaryDNS)) {
    Serial.println("[ERROR] STA Failed to configure Static IP!");
  } else {
    Serial.println("[INFO] Static IP configuration applied successfully.");
  }

  // Connect to Wi-Fi
  Serial.print("\nConnecting to Wi-Fi: ");
  Serial.println(ssid);
  WiFi.begin(ssid, password);
  
  // Allow up to 20 seconds (40 attempts * 500ms) for connection
  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 40) {
    delay(500);
    Serial.print(".");
    attempts++;
  }
  
  if (WiFi.status() != WL_CONNECTED) {
    Serial.printf("\n[ERROR] Failed to connect to WiFi! Status: %d\n", WiFi.status());
    Serial.println("Retrying connection without restarting...");
    WiFi.reconnect();
    int retryAttempts = 0;
    while (WiFi.status() != WL_CONNECTED && retryAttempts < 20) {
      delay(500);
      Serial.print(".");
      retryAttempts++;
    }
  }
  
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\nWi-Fi connected successfully!");
    Serial.print("ESP32 Static IP address: ");
    Serial.println(WiFi.localIP());
    Serial.print("Gateway IP: ");
    Serial.println(WiFi.gatewayIP());
    Serial.print("Subnet Mask: ");
    Serial.println(WiFi.subnetMask());
    Serial.print("MAC Address: ");
    Serial.println(WiFi.macAddress());
    Serial.print("Target Server URL: ");
    Serial.println(serverUrl);
  } else {
    Serial.println("\n[ERROR] Still could not connect to Wi-Fi. Check SSID, password, or router settings.");
  }

  // Setup Web Server Endpoint to start the buzzer
  server.on("/buzzer/start", []() {
    isBuzzing = true;
    isFaceVerified = false; // Fresh schedule: MUST wait for registered face detection first!
    server.send(200, "application/json", "{\"success\":true,\"message\":\"Buzzer started\"}");
    Serial.println("[INFO] Server requested to start the buzzer! Waiting for registered face...");
  });

  // Setup Web Server Endpoint to stop the buzzer
  server.on("/buzzer/stop", []() {
    isBuzzing = false;
    digitalWrite(buzzerPin, LOW);
    buzzerState = false;
    isFaceVerified = false; // Reset face verification state
    server.send(200, "application/json", "{\"success\":true,\"message\":\"Buzzer stopped\"}");
    Serial.println("[INFO] Server requested to stop the buzzer!");
  });

  // Setup Web Server Endpoint when a registered face is detected by the camera
  server.on("/face/verified", []() {
    isFaceVerified = true;
    server.send(200, "application/json", "{\"success\":true,\"message\":\"Face verified, ultrasonic sensor activated\"}");
    Serial.println("[INFO] >>> Registered face verified! Ultrasonic sensor is now ARMED to detect hand proximity.");
  });

  // Setup Web Server Endpoint to reset face verification (e.g. timeout or schedule expired)
  server.on("/face/reset", []() {
    isFaceVerified = false;
    server.send(200, "application/json", "{\"success\":true,\"message\":\"Face verification reset\"}");
    Serial.println("[INFO] Face verification reset. Ultrasonic sensor is now IGNORING objects.");
  });

  // Setup Web Server Endpoint to spin servo
  server.on("/servo/spin", []() {
    if (!server.hasArg("pin") || !server.hasArg("degree")) {
      server.send(400, "text/plain", "Missing pin or degree");
      return;
    }
    
    int pin = server.arg("pin").toInt();
    int degree = server.arg("degree").toInt();
    long duration = server.hasArg("duration") ? server.arg("duration").toInt() : 1000;
    
    if (degree < 0 || degree > 180) {
      server.send(400, "text/plain", "Degree must be 0-180");
      return;
    }
    
    if (activeServoPin != pin) {
      if (activeServoPin != -1) {
        myServo.detach();
      }
      myServo.setPeriodHertz(50);
      myServo.attach(pin, 500, 2400);
      activeServoPin = pin;
      startDegree = myServo.read();
    } else {
      startDegree = myServo.read();
    }
    
    targetDegree = degree;
    spinDuration = duration;
    spinStartTime = millis();
    isServoSpinning = true;
    
    Serial.printf("[INFO] Spinning servo on pin %d to %d degrees over %d ms\n", pin, degree, duration);
    server.send(200, "application/json", "{\"success\":true,\"message\":\"Spinning servo\"}");
  });

  // Setup Web Server Endpoint to trigger pump for specific milliseconds
  server.on("/relay/pump", []() {
    if (!server.hasArg("ms")) {
      server.send(400, "application/json", "{\"success\":false,\"message\":\"Missing ms argument\"}");
      return;
    }
    long duration = server.arg("ms").toInt();
    if (duration <= 0) {
      server.send(400, "application/json", "{\"success\":false,\"message\":\"Invalid ms duration\"}");
      return;
    }
    
    pumpDuration = duration;
    pumpStartTime = millis();
    isPumping = true;
    
    digitalWrite(relayPin, LOW); // Active-Low (Turn ON)
    
    Serial.printf("[INFO] Server requested Relay/Pump ON for %ld ms!\n", duration);
    server.send(200, "application/json", "{\"success\":true,\"message\":\"Pump started\"}");
  });

  server.begin();
  Serial.println("ESP32 Web Server started");
}

void loop() {
  // Listen for incoming requests from Node.js server
  server.handleClient();

  // --- Non-blocking Servo Logic ---
  if (isServoSpinning) {
    unsigned long elapsed = millis() - spinStartTime;
    if (elapsed >= spinDuration) {
      myServo.write(targetDegree);
      isServoSpinning = false;
    } else {
      float progress = (float)elapsed / (float)spinDuration;
      int currentDeg = startDegree + (targetDegree - startDegree) * progress;
      myServo.write(currentDeg);
    }
  }

  // --- Non-blocking Buzzer Logic ---
  if (isBuzzing) {
    if (millis() - lastBeepTime > 500) { // Beep on and off every 500ms
      buzzerState = !buzzerState;
      digitalWrite(buzzerPin, buzzerState ? HIGH : LOW);
      lastBeepTime = millis();
    }
  } else {
    if (buzzerState) { // Ensure buzzer is completely off when not buzzing
      digitalWrite(buzzerPin, LOW);
      buzzerState = false;
    }
  }

  // --- Non-blocking Pump Logic ---
  if (isPumping) {
    if (millis() - pumpStartTime >= pumpDuration) {
      isPumping = false;
      digitalWrite(relayPin, HIGH); // Turn OFF relay
      Serial.println("[INFO] Pump finished");
    }
  }

  // --- Non-blocking Sensor Read Logic (every 200ms) ---
  if (millis() - lastSensorRead > 200) {
    lastSensorRead = millis();

    digitalWrite(trigPin, LOW);
    delayMicroseconds(2);
    
    digitalWrite(trigPin, HIGH);
    delayMicroseconds(10);
    digitalWrite(trigPin, LOW);
    
    long duration = pulseIn(echoPin, HIGH, 30000); // 30ms timeout prevents blocking if disconnected
    float distanceCm = (duration * 0.0343) / 2.0;
    float distanceInches = distanceCm / 2.54;

    // Check if an object/person is within 20 inches (50.8 cm)
    bool currentlyDetecting = (distanceCm >= MIN_DISTANCE_CM && distanceCm <= TRIGGER_DISTANCE_CM);

    // --- Status Tracking ---
    if (currentlyDetecting != isObjectPresent) {
      isObjectPresent = currentlyDetecting; // Update the tracked status

      if (isObjectPresent) {
        Serial.printf("[INFO] Object detected at %.1f cm (%.1f inches)!\n", distanceCm, distanceInches);
      } else {
        Serial.println("[INFO] Object removed!");
      }
    }

    // --- Buzzer & Server Trigger Logic ---
    // STRICT ORDER ENFORCEMENT:
    // If NO registered face has been detected yet (isFaceVerified == false):
    // COMPLETELY IGNORE the object near the ultrasonic sensor!
    // Do NOT trigger dispenser, do NOT stop buzzer, do NOT send HTTP request.
    // The buzzer continues sounding and the dispenser will not dispense.
    if (!isFaceVerified) {
      // Ignored: Registered face must be detected first before ultrasonic sensor can activate!
    } else if (currentlyDetecting) {
      if (millis() - lastTriggerTime > COOLDOWN_MS) {
        Serial.printf("[ULTRASONIC SENSOR] Registered face confirmed! Object detected in range: %.1f cm (%.1f in). Requesting dispense from server...\n", distanceCm, distanceInches);
        triggerServer(distanceCm);
        lastTriggerTime = millis();
      }
    }
  }
}

// --- FreeRTOS Task for Non-Blocking HTTP Request ---
void sendHttpRequestTask(void * parameter) {
  float dist = 20.0;
  if (parameter != NULL) {
    dist = *((float*)parameter);
    free(parameter);
  }

  if (WiFi.status() == WL_CONNECTED) {
    HTTPClient http;
    
    http.begin(serverUrl);
    http.addHeader("Content-Type", "application/json");

    String jsonBody = String("{\"distance\":") + String(dist, 1) + ",\"distance_unit\":\"cm\"}";
    int httpResponseCode = http.POST(jsonBody);

    if (httpResponseCode > 0) {
      String payload = http.getString();
      Serial.printf("[HTTP Response %d] %s\n", httpResponseCode, payload.c_str());

      // Verify if server successfully authorized and dispensed
      if (httpResponseCode == 200 && payload.indexOf("\"success\":true") >= 0) {
        Serial.println(">>> [STEP 3/3 COMPLETE] Dispense SUCCESS! Face verified & Object detected in range. Stopping buzzer.");
        isBuzzing = false;
        digitalWrite(buzzerPin, LOW);
        buzzerState = false;
        isFaceVerified = false; // Reset face verification gate for the next cycle
      } else if (httpResponseCode == 403) {
        Serial.println(">>> [STEP 1/3 BLOCKED] Dispense BLOCKED: Registered face has NOT been detected yet! Order strictly enforced.");
      } else if (httpResponseCode == 400) {
        Serial.println(">>> [STEP 0/3 IGNORED] Dispense IGNORED: No medicine schedule is currently queued.");
      }
    } else {
      Serial.printf("[HTTP Error %d] Make sure your Node server IP in serverUrl is reachable!\n", httpResponseCode);
    }
    http.end();
  } else {
    Serial.println("[HTTP Task] WiFi Disconnected");
  }
  
  isSendingRequest = false;
  // Clean up and delete this task when finished
  vTaskDelete(NULL);
}

void triggerServer(float distanceCm) {
  if (isSendingRequest) {
    return; // Don't spawn concurrent HTTP tasks
  }
  isSendingRequest = true;

  // Pass distance parameter to background task
  float* pDist = (float*)malloc(sizeof(float));
  if (pDist != NULL) {
    *pDist = distanceCm;
  }

  // Spin up a background task on the ESP32 to handle the HTTP request.
  // This allows the main loop() (and the relay/buzzer) to continue instantly!
  xTaskCreate(
    sendHttpRequestTask,    // Task function
    "SendHTTPTask",         // Task name
    8192,                   // Stack size (HTTPClient needs a bit of memory)
    pDist,                  // Parameter (distance in cm)
    1,                      // Priority (1 is low priority, good for background)
    NULL                    // Task handle
  );
}
