@echo off
title AlertMed - Face Detection Terminal (External Webcam)
color 0A
echo =========================================================
echo       ALERTMED HEADLESS FACE DETECTION TERMINAL
echo =========================================================
echo.
echo Connecting to external webcam and starting headless detection...
echo (Press Ctrl+C in this window at any time to stop)
echo.
cd /d "%~dp0"
python detect_face_terminal.py --cam 1
pause
