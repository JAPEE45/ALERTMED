#!/usr/bin/env python3
"""
AlertMed - Set Schedule & Rotate Pin 5 Servo
Usage: python set_schedule.py <time_HH:MM> [pin5_degree]
       python set_schedule.py <time_HH:MM> --degree <pin5_degree>
       python set_schedule.py --degree <pin5_degree>
"""

import sys
import re
import json
import urllib.request
import urllib.error

TILE_PIN = 12
MEDICINE_NAME = "Paracetamol"
SCHEDULE_TYPE = "once_daily"
DAYS = "daily"

SERVO_ESP32_URL = "http://10.180.37.20:8080"
SERVER_URL = "http://127.0.0.1:3000"

def rotate_pin5_servo(degree):
    try:
        deg = int(degree)
    except ValueError:
        print(f"[ERROR] Invalid degree '{degree}'. Must be a number between 0 and 180.")
        return False

    if deg < 0 or deg > 180:
        print(f"[ERROR] Invalid degree {deg}. Must be between 0 and 180.")
        return False

    print(f"\n[SERVO PIN 5] Sending command to rotate Pin 5 servo to {deg} degrees...")
    url = f"{SERVO_ESP32_URL}/spin?pin=5&degree={deg}&duration=1000"
    try:
        req = urllib.request.Request(url, method='GET')
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode())
            print(f"[SUCCESS] Pin 5 servo rotated to {deg} degrees! ({data.get('message', 'OK')})")
            return True
    except Exception as e:
        print(f"[ERROR] Failed to rotate Pin 5 servo at {SERVO_ESP32_URL}: {e}")
        return False

def main():
    args = sys.argv[1:]
    if len(args) < 1:
        print("=" * 60)
        print("          AlertMed - Set Schedule & Servo")
        print("=" * 60)
        print("Usage: python set_schedule.py <time_HH:MM> [pin5_degree]")
        print("       python set_schedule.py <time_HH:MM> --degree <pin5_degree>")
        print("       python set_schedule.py --degree <pin5_degree>")
        print("")
        print("Examples:")
        print("  python set_schedule.py 22:50")
        print("  python set_schedule.py 22:50 90")
        print("  python set_schedule.py 22:50 --degree 180")
        print("  python set_schedule.py --degree 45")
        print("=" * 60)
        sys.exit(1)

    time_val = None
    pin5_degree = None

    i = 0
    while i < len(args):
        arg = args[i]
        if arg in ('--degree', '-d', '--deg'):
            if i + 1 < len(args):
                pin5_degree = args[i + 1]
                i += 1
        elif not time_val and re.match(r'^([01]\d|2[0-3]):([0-5]\d)$', arg):
            time_val = arg
        elif pin5_degree is None and arg.isdigit() and ':' not in arg:
            pin5_degree = arg
        i += 1

    # 1. Rotate Pin 5 servo if degree is provided
    if pin5_degree is not None:
        rotate_pin5_servo(pin5_degree)

    # 2. Add schedule if time is provided
    if time_val:
        print(f"\n[SCHEDULE] Setting up Tile (Pin {TILE_PIN}) with {MEDICINE_NAME}...")
        try:
            req = urllib.request.Request(
                f"{SERVER_URL}/api/update-medicine",
                data=json.dumps({'pin': TILE_PIN, 'name': MEDICINE_NAME}).encode('utf-8'),
                headers={'Content-Type': 'application/json'},
                method='POST'
            )
            with urllib.request.urlopen(req, timeout=3) as resp:
                data = json.loads(resp.read().decode())
                print(f"[SUCCESS] {data.get('message', 'Medicine updated')}")
        except Exception as e:
            print(f"[ERROR] Could not update medicine: {e}")

        print(f"[SCHEDULE] Adding schedule at {time_val}...")
        try:
            req = urllib.request.Request(
                f"{SERVER_URL}/api/schedule",
                data=json.dumps({
                    'pin': TILE_PIN,
                    'time': time_val,
                    'schedule_type': SCHEDULE_TYPE,
                    'days': DAYS
                }).encode('utf-8'),
                headers={'Content-Type': 'application/json'},
                method='POST'
            )
            with urllib.request.urlopen(req, timeout=3) as resp:
                data = json.loads(resp.read().decode())
                print(f"[SUCCESS] Schedule {time_val} added to tile {TILE_PIN}")
        except Exception as e:
            print(f"[ERROR] Could not add schedule: {e}")

if __name__ == "__main__":
    main()
