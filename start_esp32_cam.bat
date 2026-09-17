@echo off
title AlertMed ESP32-CAM Launcher
color 0B
echo =========================================================
echo    ALERTMED ESP32-CAM STREAMING & RECOGNITION SERVER
echo =========================================================
echo.
echo [1/2] Starting AlertMed Node.js API Server (Port 3000)...
start "AlertMed Server" cmd /k "cd /d "%~dp0server" && node index.js"

echo.
echo [2/2] Starting ESP32-CAM WebSocket Streaming Server (Port 5050)...
start "AlertMed ESP32-CAM Stream" cmd /k "cd /d "%~dp0localStreamCamera" && python local_server.py"

echo.
echo =========================================================
echo  AlertMed is running with ESP32-CAM mode on ws://[PC_IP]:5050/stream
echo =========================================================
pause
