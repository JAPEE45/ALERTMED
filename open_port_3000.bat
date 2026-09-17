@echo off
title AlertMed - Open Firewall Port 3000 (Run as Admin)
echo =========================================================
echo       ALERTMED FIREWALL CONFIGURATION UTILITY
echo =========================================================
echo.
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo [WARNING] Administrative privileges required.
    echo Please right-click this file and select "Run as administrator".
    echo.
    pause
    exit /b 1
)

echo Adding Windows Firewall rule for Port 3000 (AlertMed Server)...
netsh advfirewall firewall add rule name="Allow AlertMed Node Port 3000" dir=in action=allow protocol=TCP localport=3000
echo.
echo [SUCCESS] Rule added successfully! Port 3000 is now open for the ESP32.
echo.
pause
