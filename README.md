# 💊 AlertMed: Smart IoT Medication Dispenser & Adherence Monitor

[![Platform](https://img.shields.io/badge/Platform-Android%20%7C%20iOS%20%7C%20ESP32-blue.svg)](#)
[![Stack](https://img.shields.io/badge/Frontend-React%20Native%20%2F%20Expo-green.svg)](#)
[![Backend](https://img.shields.io/badge/Backend-Node.js%20%2F%20Express-lightgrey.svg)](#)
[![AI](https://img.shields.io/badge/Vision-OpenCV%20YuNet%20%2B%20SFace-orange.svg)](#)
[![Database](https://img.shields.io/badge/Database-SQLite-blue.svg)](#)
[![License](https://img.shields.io/badge/License-MIT-brightgreen.svg)](#)

> **"Bridging intelligent computer vision and precision embedded hardware to deliver secure, automated, and error-free medication management right into patients' hands."**

---

### 🎓 Academic Capstone Project
* **Author / Developer:** College Student ([mayma4545](https://github.com/JAPEE45))
* **Institution:** *[Insert Your College / University Name Here, e.g., Pamantasan ng Lungsod ng Maynila / PUP / DLSU]*
* **Completion Date:** September 17, 2026
* **Repository:** [github.com/JAPEE45/ALERTMED](https://github.com/JAPEE45/ALERTMED)

---

## 📑 Table of Contents
1. [Project Overview](#-project-overview)
2. [Why Use AlertMed? (User Benefits)](#-why-use-alertmed-user-benefits)
3. [Key Features](#-key-features)
4. [Hardware Materials & Bill of Materials](#-hardware-materials--bill-of-materials)
5. [Visual Proof & System Showcase](#-visual-proof--system-showcase)
6. [Tech Stack](#-tech-stack)
7. [How the System Works (End-to-End Workflow)](#-how-the-system-works-end-to-end-workflow)
8. [Installation & Setup Instructions](#-installation--setup-instructions)
9. [Circuit Diagram & Hardware Architecture](#-circuit-diagram--hardware-architecture)
10. [Future Roadmap](#-future-roadmap)

---

## 🌟 Project Overview

**AlertMed** is a fully automated, IoT-integrated medical dispensing station accompanied by an intuitive cross-platform mobile application. Designed as a college capstone/thesis innovation, AlertMed combats one of healthcare's greatest challenges: **medication non-adherence and accidental misdosing**.

Unlike standard pill organizer boxes or pure software alarms that rely solely on human memory, AlertMed marries physical servo-driven compartment dispensers, relay-controlled liquid pumps, ultrasonic hand-sensing triggers, and AI facial recognition. Medications are dispensed **only when the verified patient is physically present**, safeguarding patients against double dosing, forgotten schedules, or unauthorized handling.

---

## 💡 Why Use AlertMed? (User Benefits)

### 🎯 Target Users
* **Elderly Individuals:** Seniors managing multiple chronic prescriptions with varying daily schedules who struggle with tiny pill labels or forgetfulness.
* **Patients with Complex Regimens:** Individuals requiring combinations of solid tablets and liquid medicines at strict, time-sensitive intervals.
* **Caregivers & Healthcare Guardians:** Family members or nursing personnel who need transparent, real-time tracking of whether their loved ones took their prescribed medication.
* **Patients with Mild Cognitive Impairment (MCI):** Those who risk double-dosing because they cannot recall if they already took their dose.

### 🛡️ Main Problems Solved
1. **Wrong-Person Ingestion Prevention:** Conventional dispensers unlock for anyone. AlertMed uses biometric **AI Face Recognition** (OpenCV YuNet + SFace) to ensure medication is released exclusively to the verified patient.
2. **Elimination of Forgotten & Double Dosing:** Automated multi-level buzzer alerts ring until the patient approaches the device. The hardware mechanically dispenses the exact dosage per tile, preventing accidental double consumption.
3. **Multi-Format Dispensing (Solid & Liquid):** Solves the limitation of traditional dispensers by handling both solid tablets/capsules (via micro servo rotary gates) and liquid medications/water (via a 5V relay-driven DC pump).
4. **Actionable Adherence Records:** Every successful dispense and missed dose is automatically logged into local SQLite and reflected in real-time adherence analytics on the mobile app.

---

## 🚀 Key Features

* 👤 **Biometric Face Verification Gate:** 
  Utilizes state-of-the-art OpenCV YuNet face detection and SFace neural feature extraction (cosine similarity $\ge 0.55$ across consecutive frames) to unlock dispensing only for registered patient profiles.
* 💊 **Multi-Slot Rotary Servo Dispenser:** 
  Independently controls up to 9 servo-driven compartments (GPIO pins: 19, 18, 5, 12, 14, 27, 26, 25, 33). Rotates precisely 40° per pill to release the exact count while synchronizing local inventory.
* 💧 **Automated Liquid Dispenser:** 
  Integrates a 1-channel optocoupler relay module driving a 5V DC submersible pump to accurately measure and dispense liquid medication (calibrated at 1,900 ms per 2.5 mL).
* 📏 **Ultrasonic Proximity Hand/Cup Detection:** 
  HC-SR04 ultrasonic distance sensor activates within a 50.8 cm (20-inch) threshold. It ensures that medication drops safely only when a hand or medicine cup is placed directly beneath the chute.
* 🔔 **Audible Schedule Reminders:** 
  High-decibel piezo buzzer alerts the user when it is time to take scheduled medication, operating on customizable schedules managed by `node-cron`.
* 📱 **Modern Mobile Companion App:** 
  Built on React Native and Expo Router. Allows patients and caregivers to configure pill counts, define dosage schedules, inspect real-time connection status with ESP32 nodes, and analyze weekly adherence percentages.

---

## 🧰 Hardware Materials & Bill of Materials

The physical station integrates several modular electronic components communicating over Wi-Fi (HTTP REST and WebSockets):

| Hardware Component | Model / Spec | Purpose in AlertMed |
| :--- | :--- | :--- |
| **Microcontroller Node 1** | ESP32-WROOM-32 DevKit | Dedicated to controlling the 9 servo motors that rotate the physical pill slots. Hosts an internal HTTP web server on port `8080`. |
| **Microcontroller Node 2** | ESP32-WROOM-32 DevKit | Dedicated to the HC-SR04 ultrasonic distance sensor, piezo buzzer alarm, and 5V liquid pump relay trigger on static IP (`10.180.37.21`). |
| **Camera Module / Webcam** | ESP32-CAM (AI-Thinker) / HD USB Webcam | Streams live video feed over WebSockets to the Python vision engine for facial verification before unlocking the hardware. |
| **Micro Servos** | TowerPro SG90 / MG90S (9 units) | Provides calibrated incremental rotation (40° per pill) to dispense pills from individual cylindrical containers into the delivery funnel. |
| **Ultrasonic Distance Sensor** | HC-SR04 (Trig: Pin 5, Echo: Pin 18) | Measures distance ($2.0\text{ cm} \le d \le 50.8\text{ cm}$). Acts as a safety gate to confirm patient cup/hand presence. |
| **1-Channel Relay Module** | 3.3V / 5V High/Low Trigger Relay (Pin 13) | Electronically isolates and switches the 5V DC submersible water pump for liquid medicine delivery. |
| **Mini Submersible DC Pump** | 3V–5V DC Water Pump | Dispenses liquid medications or drinking water through flexible silicone tubing into the patient's cup. |
| **Piezo Buzzer** | Active 5V Buzzer (Pin 4) | Emits rhythmic acoustic reminders when scheduled medication times are reached. |
| **Power Supply Units** | 5V 3A / 9V DC Adapter + Buck Converters | Powers microcontrollers and servo power rails to eliminate voltage sags during simultaneous motor rotations. |

---

## 📸 Visual Proof & System Showcase

### Mobile Application User Interface

Below are high-resolution captures from the working mobile application operating on Android/iOS via Expo:

<p align="center">
  <img src="Project%20videos/782455549_1568933794634942_815735482482548014_n.jpg" width="360" alt="Medication Inventory Screen" style="border-radius: 12px; margin-right: 15px;" />
  &nbsp;&nbsp;&nbsp;&nbsp;
  <img src="Project%20videos/778659789_1376748104003718_4707756292921358159_n.jpg" width="360" alt="Adherence History Screen" style="border-radius: 12px;" />
</p>

* **Figure 1 (Left):** *My Inventory & Medication Management* — Displays real-time pill inventory (`12 left`, `45 left`), dosage requirements (e.g., *Amoxicillin 500mg*, *Cough Syrup 10ml*), frequency tags, and quick edit/deletion capabilities.
* **Figure 2 (Right):** *Adherence History & Consistency Dashboard* — Tracks weekly adherence rate (**85%**), daily logs of taken vs. missed medications with automated timestamps verified by the Smart Dispenser.

### Hardware & Prototype Demonstrations
The repository includes prototype video recordings and circuit design schematics:
* 📐 **Hardware Schematic:** Refer to [circuit diagram.drawio](file:///circuit%20diagram.drawio) for full wiring schematics between the ESP32 microcontrollers, servos, relay, and ultrasonic sensor.
* 🎥 **Live Operation Clips:** Located in the [`Project videos/`](file:///Project%20videos/) directory demonstrating automated pill drop and sensor triggering.

---

## 💻 Tech Stack

### Mobile Application (Frontend)
* **Framework:** React Native 0.86 with Expo SDK 57
* **Routing:** Expo Router (File-based navigation)
* **Local Storage:** SQLite (`expo-sqlite`) for offline-first caching
* **Animation & Gestures:** `react-native-reanimated` & `react-native-gesture-handler`
* **Icons:** `@expo/vector-icons`

### Central Controller & API (Backend)
* **Runtime:** Node.js (CommonJS)
* **Web Framework:** Express.js 5.x
* **Database:** SQLite 3 (`sqlite` & `sqlite3`)
* **Task Scheduler:** `node-cron` for precise scheduled dosage triggering
* **HTTP Client:** `axios` for fast asynchronous ESP32 microcontroller communication

### Computer Vision & AI Verification
* **Language:** Python 3.9+
* **Framework:** OpenCV (`cv2`)
* **Face Detection Model:** YuNet ONNX (`face_detection_yunet.onnx`)
* **Face Recognition Model:** SFace ONNX (`face_recognition_sface.onnx`)
* **Vector Math:** NumPy (Normalized 128-D cosine similarity matching)

### Embedded Microcontroller Firmware
* **Platform:** Arduino Framework / ESP-IDF via Arduino IDE
* **Libraries:** `WiFi.h`, `WebServer.h`, `HTTPClient.h`, `ESP32Servo.h`, `WebSocketsClient.h`

---

## 🔄 How the System Works (End-to-End Workflow)

```
+-----------------------------------------------------------------------------------+
| 1. Mobile App Setup: User inputs medication name, slot (pin), and dosage schedule |
+-----------------------------------------+-----------------------------------------+
                                          |
                                          v
+-----------------------------------------------------------------------------------+
| 2. Backend Sync & Cron: Node.js stores schedule in SQLite & schedules cron timer  |
+-----------------------------------------+-----------------------------------------+
                                          |
                                          v
+-----------------------------------------------------------------------------------+
| 3. Dose Alarm: Scheduled time triggers ESP32 Piezo Buzzer to sound alerts         |
+-----------------------------------------+-----------------------------------------+
                                          |
                                          v
+-----------------------------------------------------------------------------------+
| 4. AI Biometric Check: Patient approaches camera; YuNet + SFace verifies identity |
+-----------------------------------------+-----------------------------------------+
                                          |
                                          v
+-----------------------------------------------------------------------------------+
| 5. Ultrasonic Proximity: Patient extends hand/cup (< 50.8 cm) to ultrasonic sensor|
+-----------------------------------------+-----------------------------------------+
                                          |
                                          v
+-----------------------------------------------------------------------------------+
| 6. Precision Dispense: ESP32 rotates corresponding servo (solid) or relay (liquid)|
+-----------------------------------------+-----------------------------------------+
                                          |
                                          v
+-----------------------------------------------------------------------------------+
| 7. Stock & Log Update: Pill count decrements; successful log recorded in database  |
+-----------------------------------------------------------------------------------+
```

1. **Patient Registration & Profile Setup:**
   The user opens the AlertMed mobile app to register their medications, designating dosage quantities, time schedules, and assigned dispenser slots (pins 5 to 33). Facial features are extracted and stored as a normalized `.npy` vector in `localStreamCamera/registered_faces/`.
2. **Automated Alarm Activation:**
   At the scheduled dosage time, the Node.js backend cron job flags an active dispense window and commands the Ultrasonic ESP32 to sound the piezo buzzer.
3. **Face Verification (Safety Gate 1):**
   The patient stands in front of the camera. The Python computer vision daemon processes the video stream. If the facial embeddings match the registered patient ($\ge 0.55$ cosine similarity) across 3 consecutive frames, the buzzer stops and the ultrasonic sensor is primed.
4. **Hand / Cup Detection (Safety Gate 2):**
   The patient positions their medication cup or hand beneath the dispensing chute. The HC-SR04 ultrasonic sensor detects an obstacle within $50.8\text{ cm}$ ($20\text{ inches}$) and sends an HTTP notification to the server.
5. **Dispense Execution:**
   - For **solid pills**, the server signals the Servo ESP32 (`/rotate?pin=XX&degrees=40`), revolving the cylinder to eject one tablet.
   - For **liquid medicine**, the server triggers the relay (`Pin 13`) to run the pump for the exact duration needed for the required milliliters.
6. **Inventory Tracking & Adherence Logging:**
   The database updates the inventory count (`count = count - 1`) and logs a `"Taken"` record. The mobile app dashboard refreshes to show the updated adherence rate.

---

## 🛠️ Installation & Setup Instructions

### Prerequisites
* **Node.js** (v18.x or higher) & **npm**
* **Python** (v3.9 or higher) with `pip`
* **Arduino IDE** (with ESP32 board support installed)
* **Expo CLI** (`npm install -g expo-cli`) or Expo Go installed on your smartphone
* All ESP32 devices, the host computer, and the smartphone connected to the **same Wi-Fi Local Area Network (LAN)**

---

### Step 1: Clone the Repository
```bash
git clone https://github.com/JAPEE45/ALERTMED.git
cd ALERTMED
```

---

### Step 2: Set Up & Run the Backend Server
```bash
cd server
npm install
node index.js
```
*The Express server will start listening on `http://localhost:3000` (or `http://YOUR_LOCAL_IP:3000`).*

---

### Step 3: Set Up & Launch the Mobile App
```bash
cd ../Alertmed
npm install
npx expo start
```
* Scan the displayed QR code with the **Expo Go** app (Android) or **Camera** (iOS).
* Press `a` in the terminal to launch on an Android emulator or device connected via ADB.

---

### Step 4: Set Up the Facial Recognition Vision Engine
```bash
# In the root directory:
pip install opencv-python numpy requests

# Run the terminal face detection monitor:
python detect_face_terminal.py
```
*To register a new patient's face, run:*
```bash
python localStreamCamera/webcam_face_recognition.py
```

---

### Step 5: Flash the Microcontrollers
1. Open the Arduino IDE.
2. Under **Tools > Board**, select **ESP32 Dev Module**.
3. Flash the sketches with your local Wi-Fi SSID, password, and server IP:
   - **Servo Controller:** Open `SERVO/SERVO.ino` and upload to your Servo ESP32.
   - **Ultrasonic & Buzzer Controller:** Open `ULTRASONIC/ULTRASONIC.ino` and upload to your Sensor ESP32.
   - **Camera (if using ESP32-CAM):** Open `localStreamCamera/localStreamCamera.ino` and upload to your ESP32-CAM module.

---

## 📊 System Verification & Testing Scripts

The repository includes pre-built automated test scripts to simulate and verify components:
* `node test_dispense.js`: Comprehensive software simulation of solid servo degree increments, liquid pump relay timings, ultrasonic distances, and stock deductions without physical hardware attached.
* `open_port_3000.bat`: Windows batch utility to open firewall rules for incoming LAN connections from mobile devices and microcontrollers.
* `run_detect_face_terminal.bat`: Quick launcher for the OpenCV biometric terminal monitor.

---

## 🔮 Future Roadmap

- [ ] Cloud synchronization (Firebase / Supabase) for remote caregiver monitoring outside the local network.
- [ ] Push notifications via Expo Push Notification Services for missed medication alerts.
- [ ] Emergency caregiver SMS alerts via Twilio if a dose remains uncollected after 30 minutes.
- [ ] 3D-printed modular chassis design files (STL format) for mass replication.

---

## 📜 License & Acknowledgments

This project is open-source under the [MIT License](file:///Alertmed/LICENSE).

Developed with pride and dedication by a **College Engineering & Technology Student** as a final capstone project. Special gratitude to mentors, faculty advisers, and peers who supported the development, wiring, and testing of **AlertMed**.
