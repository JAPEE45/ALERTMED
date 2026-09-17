#include "esp_camera.h"
#include <WiFi.h>
#include <WebSocketsClient.h> // REQUIRES LIBRARY: "WebSockets" by Markus Sattler

// ============================================================
//  ESP32-CAM (AI-Thinker) Pins
// ============================================================
#define PWDN_GPIO_NUM     32
#define RESET_GPIO_NUM    -1
#define XCLK_GPIO_NUM      0
#define SIOD_GPIO_NUM     26
#define SIOC_GPIO_NUM     27
#define Y9_GPIO_NUM       35
#define Y8_GPIO_NUM       34
#define Y7_GPIO_NUM       39
#define Y6_GPIO_NUM       36
#define Y5_GPIO_NUM       21
#define Y4_GPIO_NUM       19
#define Y3_GPIO_NUM       18
#define Y2_GPIO_NUM        5
#define VSYNC_GPIO_NUM    25
#define HREF_GPIO_NUM     23
#define PCLK_GPIO_NUM     22

// ============================================================
//  WiFi Credentials
// ============================================================
const char *ssid = "Noname";
const char *password = "TrustNo_One";

// ============================================================
//  WebSocket Server Configuration
// ============================================================
// Change to your PC's local IP where Flask is running
const char *websocket_host = "192.168.0.3"; 
const uint16_t websocket_port = 5050;
const char *websocket_path = "/stream";

// ============================================================
//  Globals
// ============================================================
bool camera_ready = false;
unsigned long last_frame_time = 0;
const int target_fps = 10;               // 10 FPS as requested
const int frame_interval = 1000 / target_fps;

WebSocketsClient webSocket;
bool is_websocket_connected = false;

void webSocketEvent(WStype_t type, uint8_t * payload, size_t length) {
  switch(type) {
    case WStype_DISCONNECTED:
      Serial.println("[WS] Disconnected from server!");
      is_websocket_connected = false;
      break;
    case WStype_CONNECTED:
      Serial.printf("[WS] Connected to server url: %s\n", payload);
      is_websocket_connected = true;
      break;
    case WStype_TEXT:
    case WStype_BIN:
    case WStype_ERROR:
    case WStype_FRAGMENT_TEXT_START:
    case WStype_FRAGMENT_BIN_START:
    case WStype_FRAGMENT:
    case WStype_FRAGMENT_FIN:
      // We don't expect to receive any messages from the server, just ignore
      break;
  }
}

void setup() {
  Serial.begin(115200);
  Serial.setDebugOutput(true);
  delay(1000);
  Serial.println("\n==========================================");
  Serial.println("  ESP32-CAM -> Python WebSocket Stream");
  Serial.println("==========================================");

  // ---- WiFi Setup ----
  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid, password);
  WiFi.setSleep(false); // Important to prevent WiFi sleep lag
  
  Serial.printf("[WIFI] Connecting to '%s'", ssid);
  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 30) {
    delay(500);
    Serial.print(".");
    attempts++;
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("[WIFI] Connected! IP: %s\n", WiFi.localIP().toString().c_str());
  } else {
    Serial.println("[WIFI] Connection failed");
    return; // Don't proceed without WiFi
  }

  // ---- Camera Configuration ----
  camera_config_t config;
  memset(&config, 0, sizeof(camera_config_t));
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer   = LEDC_TIMER_0;
  config.pin_d0       = Y2_GPIO_NUM;
  config.pin_d1       = Y3_GPIO_NUM;
  config.pin_d2       = Y4_GPIO_NUM;
  config.pin_d3       = Y5_GPIO_NUM;
  config.pin_d4       = Y6_GPIO_NUM;
  config.pin_d5       = Y7_GPIO_NUM;
  config.pin_d6       = Y8_GPIO_NUM;
  config.pin_d7       = Y9_GPIO_NUM;
  config.pin_xclk     = XCLK_GPIO_NUM;
  config.pin_pclk     = PCLK_GPIO_NUM;
  config.pin_vsync    = VSYNC_GPIO_NUM;
  config.pin_href     = HREF_GPIO_NUM;
  config.pin_sccb_sda = SIOD_GPIO_NUM;
  config.pin_sccb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn     = PWDN_GPIO_NUM;
  config.pin_reset    = RESET_GPIO_NUM;
  
  // OPTIMIZATION 1: Lower XCLK frequency to 10MHz. 
  // 20MHz often causes VSYNC interrupts to drop on many ESP32-CAM boards, 
  // causing esp_camera_fb_get() to block for seconds at a time.
  config.xclk_freq_hz = 10000000;
  
  config.pixel_format = PIXFORMAT_JPEG;
  
  // Set to 240p (QVGA = 320x240) for a massive speed boost
  config.frame_size   = FRAMESIZE_QVGA;  
  
  // OPTIMIZATION 2: Increase JPEG compression slightly (12 -> 16). 
  // Lower number = larger file. 16 reduces the payload size significantly 
  // for much faster WebSocket transmission without breaking face detection.
  config.jpeg_quality = 16;              
  config.fb_count     = 1;

  if (psramFound()) {
    config.fb_count = 2;
    config.fb_location = CAMERA_FB_IN_PSRAM;
    config.grab_mode = CAMERA_GRAB_LATEST; // Get freshest frame to avoid lag
    Serial.println("[CAM] PSRAM found, using 2 buffers"); 
  } else {
    config.fb_location = CAMERA_FB_IN_DRAM;
    config.grab_mode = CAMERA_GRAB_WHEN_EMPTY;
    Serial.println("[CAM] No PSRAM found, using DRAM");
  }

  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("[CAM] INIT FAILED: 0x%x\n", err);
  } else {
    camera_ready = true;
    Serial.println("[CAM] *** CAMERA READY ***");
  }

  // ---- WebSocket Setup ----
  webSocket.begin(websocket_host, websocket_port, websocket_path);
  webSocket.onEvent(webSocketEvent);
  webSocket.setReconnectInterval(5000); // Try to reconnect every 5 seconds if connection drops
}

void loop() {
  // Must be called repeatedly to maintain WebSocket connection and process incoming/outgoing data
  webSocket.loop();

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[WIFI] Disconnected! Reconnecting...");
    WiFi.reconnect();
    delay(1000);
    return;
  }

  // Don't capture frames if camera is broken or WebSocket isn't connected
  if (!camera_ready || !is_websocket_connected) {
    return;
  }

  unsigned long current_time = millis();
  
  if (current_time - last_frame_time >= frame_interval) {
    last_frame_time = current_time;
    
    camera_fb_t *fb = esp_camera_fb_get();
    if (!fb) {
      Serial.println("[CAM] Frame capture failed");
      return; 
    }

    // Send the raw JPEG binary frame over the WebSocket
    // This is highly efficient - no HTTP headers to attach per frame!
    webSocket.sendBIN(fb->buf, fb->len);

    esp_camera_fb_return(fb);
  }
}
