@echo off
title AlertMed - Register Face
color 0B
echo =========================================================
echo       ALERTMED FACE REGISTRATION UTILITY
echo =========================================================
echo.
set /p name=" Enter patient/user name to register: \
if \%name%\==\\ (
 echo [ERROR] Name cannot be blank.
 pause
 exit /b
)
echo.
echo Please look directly at the webcam...
cd /d \%~dp0localStreamCamera\
python webcam_face_recognition.py --register \%name%\
echo.
pause
