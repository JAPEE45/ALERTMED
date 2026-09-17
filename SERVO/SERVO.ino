#include <WiFi.h>
#include <WebServer.h>
#include <ESP32Servo.h>

const char* ssid = "J";
const char* password = "mamamo4545";

WebServer server(8080);

// Existing servos
Servo servo19;
Servo servo18;
Servo servo5;

// New servos
Servo servo12;
Servo servo14;
Servo servo27;
Servo servo26;
Servo servo25;
Servo servo33;

int pos19 = 0;
int pos18 = 0;
int pos5 = 0;
int pos12 = 0;
int pos14 = 0;
int pos27 = 0;
int pos26 = 0;
int pos25 = 0;
int pos33 = 0;

void rotateSmoothly(Servo &servo, int &currentPos, int degrees) {
  int targetPos = currentPos + degrees;
  
  // If it goes beyond 180, reset back to 0 smoothly
  if (targetPos > 180) {
    targetPos = 0; 
  }
  
  if (targetPos > currentPos) {
    for (int pos = currentPos; pos <= targetPos; pos += 1) {
      servo.write(pos);
      delay(15);
    }
  } else {
    for (int pos = currentPos; pos >= targetPos; pos -= 1) {
      servo.write(pos);
      delay(15);
    }
  }
  currentPos = targetPos;
}

void handleRotate() {
  if (server.hasArg("pin")) {
    String pin = server.arg("pin");

    // Validate the pin first before doing anything
    bool validPin = (pin == "19" || pin == "18" || pin == "5"  ||
                     pin == "12" || pin == "14" || pin == "27" ||
                     pin == "26" || pin == "25" || pin == "33");

    if (!validPin) {
      server.send(400, "application/json", "{\"success\":false,\"message\":\"Invalid Pin\"}");
      return;
    }

    // ✅ KEY FIX: Send the success response IMMEDIATELY before rotating.
    // This releases the Node server from waiting so it never times out.
    server.send(200, "application/json", "{\"success\":true,\"message\":\"Servo rotating\"}");

    // NOW rotate after the response is already sent
    if (pin == "19") rotateSmoothly(servo19, pos19, 40);
    else if (pin == "18") rotateSmoothly(servo18, pos18, 40);
    else if (pin == "5")  rotateSmoothly(servo5,  pos5,  40);
    else if (pin == "12") rotateSmoothly(servo12, pos12, 40);
    else if (pin == "14") rotateSmoothly(servo14, pos14, 40);
    else if (pin == "27") rotateSmoothly(servo27, pos27, 40);
    else if (pin == "26") rotateSmoothly(servo26, pos26, 40);
    else if (pin == "25") rotateSmoothly(servo25, pos25, 40);
    else if (pin == "33") rotateSmoothly(servo33, pos33, 40);

  } else {
    server.send(400, "application/json", "{\"success\":false,\"message\":\"Missing Pin Argument\"}");
  }
}

// Helper function to spin a servo to a specific degree over a set duration (e.g., 1 second)
void spinServo(Servo &servo, int &currentPos, int targetPos, int durationMs) {
  if (targetPos < 0) targetPos = 0;
  if (targetPos > 180) targetPos = 180;
  
  if (targetPos == currentPos) return;

  int diff = abs(targetPos - currentPos);
  // Total duration divided by number of steps
  unsigned long delayMicro = (durationMs * 1000L) / diff;
  unsigned long delayTimeMs = delayMicro / 1000;
  unsigned long remainderUs = delayMicro % 1000;

  if (targetPos > currentPos) {
    for (int pos = currentPos; pos <= targetPos; pos++) {
      servo.write(pos);
      if (delayTimeMs > 0) delay(delayTimeMs);
      if (remainderUs > 0) delayMicroseconds(remainderUs);
    }
  } else {
    for (int pos = currentPos; pos >= targetPos; pos--) {
      servo.write(pos);
      if (delayTimeMs > 0) delay(delayTimeMs);
      if (remainderUs > 0) delayMicroseconds(remainderUs);
    }
  }
  currentPos = targetPos;
}

void handleSpin() {
  if (server.hasArg("pin") && server.hasArg("degree")) {
    String pin = server.arg("pin");
    int degree = server.arg("degree").toInt();
    int duration = server.hasArg("duration") ? server.arg("duration").toInt() : 1000;

    // Validate the pin first before doing anything
    bool validPin = (pin == "19" || pin == "18" || pin == "5"  ||
                     pin == "12" || pin == "14" || pin == "27" ||
                     pin == "26" || pin == "25" || pin == "33");

    if (!validPin) {
      server.send(400, "application/json", "{\"success\":false,\"message\":\"Invalid Pin\"}");
      return;
    }

    if (degree < 0 || degree > 180) {
      server.send(400, "application/json", "{\"success\":false,\"message\":\"Invalid Degree. Must be 0-180.\"}");
      return;
    }

    server.send(200, "application/json", "{\"success\":true,\"message\":\"Servo spinning\"}");

    if (pin == "19") spinServo(servo19, pos19, degree, duration);
    else if (pin == "18") spinServo(servo18, pos18, degree, duration);
    else if (pin == "5")  spinServo(servo5,  pos5,  degree, duration);
    else if (pin == "12") spinServo(servo12, pos12, degree, duration);
    else if (pin == "14") spinServo(servo14, pos14, degree, duration);
    else if (pin == "27") spinServo(servo27, pos27, degree, duration);
    else if (pin == "26") spinServo(servo26, pos26, degree, duration);
    else if (pin == "25") spinServo(servo25, pos25, degree, duration);
    else if (pin == "33") spinServo(servo33, pos33, degree, duration);

  } else {
    server.send(400, "application/json", "{\"success\":false,\"message\":\"Missing Pin or Degree Argument\"}");
  }
}

// Helper function to keep setup() clean
void setupServo(Servo &servo, int pin, int &pos) {
  servo.setPeriodHertz(50);
  servo.attach(pin, 500, 2400);
  servo.write(pos);
}

void setup() {
  Serial.begin(115200);
  
  // Allocate timers for ESP32 PWM (these 4 timers will support up to 16 servos)
  ESP32PWM::allocateTimer(0);
  ESP32PWM::allocateTimer(1);
  ESP32PWM::allocateTimer(2);
  ESP32PWM::allocateTimer(3);
  
  // Initialize all servos
  setupServo(servo19, 19, pos19);
  setupServo(servo18, 18, pos18);
  setupServo(servo5, 5, pos5);
  setupServo(servo12, 12, pos12);
  setupServo(servo14, 14, pos14);
  setupServo(servo27, 27, pos27);
  setupServo(servo26, 26, pos26);
  setupServo(servo25, 25, pos25);
  setupServo(servo33, 33, pos33);

  // --- WIFI FIXES ---
  // 1. Force Station Mode (prevents old Access Point settings from interfering)
  WiFi.mode(WIFI_STA);
  // 2. Clear out any old saved connections in memory
  WiFi.disconnect();
  delay(1000); 

  // Connect to Wi-Fi
  Serial.print("\nConnecting to Wi-Fi: ");
  Serial.println(ssid);
  WiFi.begin(ssid, password);
  
  int attempts = 0;
  // Try for 10 seconds (20 attempts * 500ms)
  while (WiFi.status() != WL_CONNECTED && attempts < 20) {
    delay(500);
    Serial.print(".");
    attempts++;
  }
  
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("\n[ERROR] Failed to connect to WiFi! Restarting ESP32 to try again...");
    delay(1000);
    ESP.restart(); // Automatically reboot if it hangs
  }
  
  Serial.println("\nWi-Fi connected!");
  Serial.print("ESP32 IP address: ");
  Serial.println(WiFi.localIP());

  // Set up API routes
  server.on("/", []() {
    server.send(200, "text/plain", "ESP32 Servo Control");
  });
  server.on("/rotate", handleRotate);
  server.on("/spin", handleSpin);
  
  // Catch-all for invalid endpoints
  server.onNotFound([]() {
    server.send(404, "application/json", "{\"success\":false,\"message\":\"Endpoint not found\"}");
  });
  
  server.begin();
  Serial.println("ESP32 API server started");
}

void loop() {
  server.handleClient();
}
