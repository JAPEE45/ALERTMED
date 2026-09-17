# ESP32-CAM to Python WebSocket Streaming - Known Issues & Fixes

This document serves as a knowledge base for future AI agents working on this project. It details the common issues encountered when streaming live video from an ESP32-CAM to a Python Flask-Sock WebSocket server, and how they were resolved.

## 1. The Disconnection / "Corrupt JPEG data" Issue
**Symptoms:** 
- The ESP32-CAM repeatedly connects and disconnects.
- The Python server logs `Corrupt JPEG data: premature end of data segment`.

### Fix A: Separate WebSocket Receiving Thread (Python)
**The Problem:** The Python server was reading frames (`ws.receive()`) and then synchronously running Face Recognition (YuNet + SFace) in the same `while` loop. Because face recognition takes time, the server wasn't calling `ws.receive()` fast enough to process background Ping/Pong messages, causing the connection to time out.
**The Solution:** Offload `ws.receive()` to a dedicated lightweight background thread. This thread rapidly reads frames and stores only the `latest_annotated_frame` in a global variable. The main thread then runs face recognition only on the latest frame, skipping backlogged frames without blocking the socket.

### Fix B: Robust Error Handling (Python)
**The Problem:** If a partial or corrupted JPEG frame managed to arrive, `np.frombuffer` or OpenCV drawing functions would throw a Python exception, crashing the WebSocket thread entirely and terminating the connection.
**The Solution:** Wrap the entire frame decoding and face processing block in a `try...except Exception as e:` block so that bad frames are simply skipped.

## 2. ESP32 TCP Buffer / Memory Overflows
**Symptoms:** 
- The ESP32 stops sending data after a while.
- The `arduinoWebSockets` library drops the connection unexpectedly.

### Fix A: Lowering Camera Resolution (ESP32)
**The Problem:** The ESP32 was attempting to stream `FRAMESIZE_VGA` (640x480) at 15 FPS. A VGA frame can be large (40KB+). Calling `webSocket.sendBIN()` with large buffers rapidly overwhelms the limited internal TCP send buffer of the ESP32, causing a panic or memory allocation failure.
**The Solution:** Reduce `config.frame_size` to `FRAMESIZE_QVGA` (320x240) and slightly lower the JPEG quality (`config.jpeg_quality = 15`). Since YuNet resizes the input to 320x320 anyway, sending 640x480 over WiFi was a waste of bandwidth and caused instability.

### Fix B: Enabling WebSocket Heartbeats (ESP32)
**The Problem:** Without explicit pings, inactive or busy connections might be dropped by routers or the server.
**The Solution:** Add `webSocket.enableHeartbeat(15000, 3000, 2);` to the ESP32 code to actively maintain the connection state.

## 3. Hardware Upgrades
- Using the **ESP32-CAM-MB** baseboard does not require any code changes to the pinouts. The pins remain identical to the standard AI-Thinker ESP32-CAM. The MB board simply provides a built-in CH340 serial converter and auto-flash circuitry, eliminating the need for an FTDI programmer and manual BOOT button presses.
