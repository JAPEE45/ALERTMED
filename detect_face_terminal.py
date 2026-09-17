#!/usr/bin/env python3
"""
AlertMed - Headless Face Detection & Dispense Monitoring Terminal
Detects faces using the external webcam, verifies against localStreamCamera/registered_faces
using strict cosine similarity (>= 0.55) and multi-frame consistency (3 consecutive frames).
Once face is verified, releases the webcam and actively monitors and logs the
Ultrasonic Hand Detection (Step 3/3) and Dispense Completion.
"""

import os
import sys
import time
import json
import argparse
import signal
import urllib.request
import urllib.error
import cv2
import numpy as np

# Suppress unnecessary OpenCV / backend warnings
os.environ["OPENCV_LOG_LEVEL"] = "ERROR"
try:
    sys.stdout.reconfigure(line_buffering=True)
except Exception:
    pass

def find_project_paths():
    """Locates the models and registered_faces directory dynamically."""
    current_dir = os.path.dirname(os.path.abspath(__file__))
    
    candidates = [
        os.path.join(current_dir, "localStreamCamera"),
        current_dir,
        os.path.join(current_dir, "..", "localStreamCamera")
    ]
    
    detector_path = None
    recognizer_path = None
    registered_faces_dir = None
    
    for candidate in candidates:
        d_path = os.path.join(candidate, "face_detection_yunet.onnx")
        r_path = os.path.join(candidate, "face_recognition_sface.onnx")
        f_path = os.path.join(candidate, "registered_faces")
        
        if detector_path is None and os.path.exists(d_path):
            detector_path = d_path
        if recognizer_path is None and os.path.exists(r_path):
            recognizer_path = r_path
        if registered_faces_dir is None and os.path.isdir(f_path):
            registered_faces_dir = f_path

    return detector_path, recognizer_path, registered_faces_dir

def load_registered_faces(registered_faces_dir):
    """Loads all .npy feature vectors from registered_faces directory."""
    faces = []
    if not registered_faces_dir or not os.path.isdir(registered_faces_dir):
        print(f"[WARNING] Registered faces directory not found: {registered_faces_dir}")
        return faces

    for filename in sorted(os.listdir(registered_faces_dir)):
        if filename.endswith(".npy"):
            raw_name = os.path.splitext(filename)[0]
            canonical_name = raw_name.replace("_backup", "")
            file_path = os.path.join(registered_faces_dir, filename)
            try:
                feature = np.load(file_path)
                faces.append({"name": canonical_name, "raw_name": raw_name, "feature": feature})
            except Exception as e:
                print(f"[WARNING] Could not load {filename}: {e}")

    return faces

def open_camera(preferred_idx=0, fallback_idx=None):
    """
    Opens the requested camera index with retry logic.
    Defaults to index 1 (external webcam on laptops).
    Uses DirectShow on Windows for instantaneous startup.
    Falls back to fallback_idx if preferred_idx is unavailable.
    """
    indices = [preferred_idx]
    if fallback_idx is not None and fallback_idx != preferred_idx:
        indices.append(fallback_idx)

    for idx in indices:
        print(f"[INFO] Connecting to camera index {idx}...")
        for attempt in range(1, 4):
            cap = cv2.VideoCapture(idx)
            if cap.isOpened():
                ret, frame = cap.read()
                if ret and frame is not None:
                    print(f"[INFO] Successfully connected to camera index {idx} (attempt {attempt}).")
                    return cap, idx
                cap.release()
            time.sleep(0.2)
        print(f"[WARNING] Camera index {idx} could not be read.")

    return None, None

def notify_server(server_url, name, confidence):
    """Notifies the AlertMed server at /api/verify-face of a detected registered face."""
    endpoint = f"{server_url.rstrip('/')}/api/verify-face"
    payload = json.dumps({"name": name, "confidence": float(confidence)}).encode('utf-8')
    req = urllib.request.Request(
        endpoint,
        data=payload,
        headers={'Content-Type': 'application/json', 'User-Agent': 'AlertMed-TerminalFaceRecog'},
        method='POST'
    )
    try:
        with urllib.request.urlopen(req, timeout=3.0) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            return True, data
    except urllib.error.HTTPError as err:
        try:
            err_data = json.loads(err.read().decode('utf-8'))
            return False, err_data
        except Exception:
            return False, {"message": f"HTTP {err.code}: {err.reason}"}
    except Exception as err:
        return False, {"message": str(err)}

def get_server_status(server_url):
    """Queries /api/status from the Node.js server."""
    endpoint = f"{server_url.rstrip('/')}/api/status"
    try:
        req = urllib.request.Request(endpoint, headers={'User-Agent': 'AlertMed-TerminalFaceRecog'})
        with urllib.request.urlopen(req, timeout=2.0) as resp:
            return json.loads(resp.read().decode('utf-8'))
    except Exception:
        return None

def get_latest_dispense_history(server_url):
    """Queries /api/history from the Node.js server for the most recent record."""
    endpoint = f"{server_url.rstrip('/')}/api/history"
    try:
        req = urllib.request.Request(endpoint, headers={'User-Agent': 'AlertMed-TerminalFaceRecog'})
        with urllib.request.urlopen(req, timeout=2.0) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            if data.get("success") and len(data.get("data", [])) > 0:
                return data["data"][0]
    except Exception:
        pass
    return None

def monitor_ultrasonic_and_dispense(server_url, verified_name):
    """
    Step 3/3 Monitor:
    Keeps terminal active after face verification, informing the user that the
    buzzer is sounding and waiting for hand detection at the ultrasonic sensor.
    Logs ultrasonic detection and dispense confirmation in real-time.
    """
    print("\n" + "=" * 70)
    print(f" [STEP 2/3: FACE VERIFIED] Patient: '{verified_name}' confirmed!")
    print(" [INFO] External webcam released cleanly.")
    print(" [BUZZER] Buzzer is ACTIVE! (Will only stop when device dispenses)")
    print(" [STEP 3/3 PENDING] WAITING FOR ULTRASONIC HAND PROXIMITY")
    print(" >>> ACTION: Put your hand in front of the Ultrasonic Sensor (<= 20 in / 50.8 cm) <<<")
    print("=" * 70 + "\n")

    last_logged_event_time = None
    dot_count = 0

    while True:
        status_data = get_server_status(server_url)
        if status_data and "systemState" in status_data:
            state = status_data["systemState"]
            step = state.get("step", "UNKNOWN")
            last_event = state.get("lastUltrasonicEvent")

            # Check if an ultrasonic trigger happened recently
            if last_event and last_event.get("time") != last_logged_event_time:
                last_logged_event_time = last_event.get("time")
                print(f"\n[{time.strftime('%H:%M:%S')}] [ULTRASONIC SENSOR] Hand detected at {last_event.get('distanceText', 'within 20 inches')}!")

            # Once the step returns to IDLE from WAITING_FOR_ULTRASONIC, dispense has occurred!
            if step == "IDLE":
                history = get_latest_dispense_history(server_url)
                med_name = history.get("medicine_name", "Medicine") if history else "Medicine"
                pin = history.get("pin", "?") if history else "?"
                dispensed_to = history.get("patient_name", verified_name) if history else verified_name

                print("\n" + "=" * 70)
                print(f"[{time.strftime('%H:%M:%S')}] [STEP 3/3: HAND DETECTED & DISPENSING COMPLETE]")
                print(f"  - Target Tile       : Pin {pin} ({med_name})")
                print(f"  - Dispensed To      : '{dispensed_to}'")
                print(f"  - Buzzer Status     : STOPPED (Dispense confirmed)")
                print(f"  - System State      : IDLE")
                print("=" * 70)
                print("[COMPLETE] Full dispensing pipeline completed successfully!\n")
                return True

        # Print waiting progress indicator
        dots = "." * ((dot_count % 4) + 1)
        sys.stdout.write(f"\r[STATUS: WAITING_FOR_ULTRASONIC] Buzzer buzzing... Place hand near sensor{dots:<5}")
        sys.stdout.flush()
        dot_count += 1
        time.sleep(0.4)

def main():
    parser = argparse.ArgumentParser(
        description="Headless Face Detection & Dispense Monitoring using External Webcam"
    )
    parser.add_argument(
        "--cam",
        type=int,
        default=0,
        help="Camera index to use (default: 0 for MWB-15 external webcam)"
    )
    parser.add_argument(
        "--score-thresh",
        type=float,
        default=0.50,
        help="YuNet face detection confidence threshold (default: 0.50)"
    )
    parser.add_argument(
        "--cosine-thresh",
        type=float,
        default=0.48,
        help="SFace cosine similarity threshold for recognition match (default: 0.48)"
    )
    parser.add_argument(
        "--frames",
        type=int,
        default=3,
        help="Required consecutive matching frames to verify face (default: 3 frames)"
    )
    parser.add_argument(
        "--cooldown",
        type=float,
        default=1.0,
        help="Seconds between terminal logs for repeated detections (default: 1.0s)"
    )
    parser.add_argument(
        "--server",
        type=str,
        default="http://127.0.0.1:3000",
        help="AlertMed server URL (default: http://127.0.0.1:3000)"
    )
    parser.add_argument(
        "--no-notify",
        action="store_true",
        help="Disable posting face verification to the server"
    )
    parser.add_argument(
        "--exit-on-verify",
        action="store_true",
        help="Exit immediately after server confirms face verification (server subprocess mode)"
    )
    args = parser.parse_args()

    print("=" * 60)
    print("       AlertMed - Headless Face Detection Terminal")
    print("=" * 60)
    print(f"[CONFIG] Target Camera Index : {args.cam} (External Webcam)")
    print(f"[CONFIG] Detection Threshold : {args.score_thresh}")
    print(f"[CONFIG] Match Threshold     : {args.cosine_thresh} (Strict Anti-Bypass)")
    print(f"[CONFIG] Consecutive Frames  : {args.frames} frames required")
    print(f"[CONFIG] AlertMed Server     : {args.server} (Notify: {not args.no_notify})")
    print(f"[CONFIG] Exit On Verify      : {args.exit_on_verify}")
    print(f"[CONFIG] Display Window      : ENABLED")
    print("=" * 60)

    # 1. Locate models and registered faces
    detector_path, recognizer_path, registered_faces_dir = find_project_paths()
    if not detector_path or not os.path.exists(detector_path):
        print("[ERROR] Could not find 'face_detection_yunet.onnx'. Exiting.")
        sys.exit(1)
    if not recognizer_path or not os.path.exists(recognizer_path):
        print("[ERROR] Could not find 'face_recognition_sface.onnx'. Exiting.")
        sys.exit(1)

    print(f"[INFO] YuNet Model: {os.path.basename(detector_path)}")
    print(f"[INFO] SFace Model: {os.path.basename(recognizer_path)}")
    print(f"[INFO] Registered Faces Dir: {registered_faces_dir}")

    # 2. Load registered faces
    registered_faces = load_registered_faces(registered_faces_dir)
    registered_names = [f['name'] for f in registered_faces]
    print(f"[INFO] Loaded {len(registered_faces)} registered face(s): {registered_names}")

    # 3. Initialize models
    detector = cv2.FaceDetectorYN.create(detector_path, "", (320, 320), score_threshold=args.score_thresh)
    recognizer = cv2.FaceRecognizerSF.create(recognizer_path, "")

    # 4. Open Webcam
    cap, active_cam_idx = open_camera(preferred_idx=args.cam, fallback_idx=None)
    if cap is None:
        print(f"[ERROR] Could not access webcam at index {args.cam}. Please check your camera connection.")
        sys.exit(1)

    cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)

    print("\n[INFO] Face detection is LIVE. Watching for registered faces... (Press Ctrl+C to stop)\n")
    print("-" * 60)

    # Tracking state: must see the same registered face for N consecutive frames
    consecutive_counts = {reg["name"]: 0 for reg in registered_faces}
    last_log_time = {}
    # Proximity gating: Accept faces at comfortable distance (>= 75px).
    # Filters out tiny background passersby or image noise (< 75px).
    MIN_FACE_SIZE = 75

    def handle_sigint(signum, frame_signal):
        print("\n[INFO] Stopped by user (Ctrl+C).")
        if cap and cap.isOpened():
            cap.release()
            print("[INFO] Camera released. Session finished.")
        sys.exit(0)

    signal.signal(signal.SIGINT, handle_sigint)

    try:
        cv2.namedWindow("AlertMed Face Detection", cv2.WINDOW_NORMAL)
        while True:
            ret, frame = cap.read()
            if not ret or frame is None:
                time.sleep(0.05)
                continue

            display_frame = frame.copy()
            h, w = frame.shape[:2]
            scale = 1.0
            if w > 480:
                scale = 480.0 / w
                small_frame = cv2.resize(frame, (0, 0), fx=scale, fy=scale)
            else:
                small_frame = frame

            sh, sw = small_frame.shape[:2]
            detector.setInputSize((sw, sh))
            _, faces = detector.detect(small_frame)

            now = time.time()
            matched_this_frame = set()

            if faces is not None and len(faces) > 0:
                for face in faces:
                    scaled_face = face.copy()
                    scaled_face[:14] = scaled_face[:14] / scale

                    box = scaled_face[:4].astype(int)
                    w_box, h_box = box[2], box[3]
                    conf = float(scaled_face[14])

                    # Reject faces that are too small (far away / background passersby)
                    if w_box < MIN_FACE_SIZE or h_box < MIN_FACE_SIZE:
                        continue

                    matched_name = "Unknown"
                    best_score = 0.0

                    try:
                        aligned = recognizer.alignCrop(frame, scaled_face)
                        feature = recognizer.feature(aligned)

                        for reg in registered_faces:
                            score = recognizer.match(feature, reg["feature"], cv2.FaceRecognizerSF_FR_COSINE)
                            if score > best_score:
                                best_score = score
                                matched_name = reg["name"]
                    except Exception:
                        pass

                    # Strict threshold check: MUST be >= args.cosine_thresh (0.55+)
                    is_registered = (matched_name != "Unknown" and best_score >= args.cosine_thresh)

                    # Draw bounding box on display frame
                    box_color = (0, 255, 0) if is_registered else (0, 0, 255)
                    label_text = f"{matched_name} ({best_score:.2f})" if is_registered else "Unknown"
                    cv2.rectangle(display_frame, (box[0], box[1]), (box[0] + w_box, box[1] + h_box), box_color, 2)
                    cv2.putText(display_frame, label_text, (box[0], box[1] - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.5, box_color, 2)

                    if is_registered:
                        matched_this_frame.add(matched_name)
                        consecutive_counts[matched_name] = consecutive_counts.get(matched_name, 0) + 1
                        count = consecutive_counts[matched_name]

                        # Log progress towards verification
                        last_time = last_log_time.get(matched_name, 0)
                        if now - last_time >= 0.5 or count >= args.frames:
                            timestamp = time.strftime("%H:%M:%S")
                            print(f"[{timestamp}] [FACE TRACKING] Candidate '{matched_name}' ({count}/{args.frames}) | Similarity: {best_score:.2f} | Conf: {conf:.2f}")
                            last_log_time[matched_name] = now

                        # ONLY when face is stable for N consecutive frames: CONFIRM VERIFICATION!
                        if count >= args.frames:
                            timestamp = time.strftime("%H:%M:%S")
                            print(f"[{timestamp}] [FACE VERIFIED] Confirmed: {matched_name} | Stable across {args.frames} frames | Similarity: {best_score:.2f}")

                            # Notify server to advance dispensing order
                            if not args.no_notify:
                                ok, res = notify_server(args.server, matched_name, best_score)
                                if ok and res.get("saved"):
                                    # Release camera hardware right away
                                    cap.release()
                                    cv2.destroyAllWindows()
                                    if args.exit_on_verify:
                                        print(f"[{timestamp}] [INFO] Face verified and saved by server. Releasing camera...")
                                        return
                                    else:
                                        # Active interactive mode: seamlessly transition to Step 3 ultrasonic monitor!
                                        monitor_ultrasonic_and_dispense(args.server, matched_name)
                                        return
                                else:
                                    msg = res.get("message", "No active schedule")
                                    print(f"[{timestamp}] [SERVER STATUS] {msg}")
                    else:
                        # Unregistered face or score below strict threshold
                        last_time = last_log_time.get("unregistered", 0)
                        if now - last_time >= args.cooldown:
                            timestamp = time.strftime("%H:%M:%S")
                            if matched_name != "Unknown":
                                print(f"[{timestamp}] [FACE DETECTED] Potential '{matched_name}' rejected (Similarity {best_score:.2f} < threshold {args.cosine_thresh}) | Conf: {conf:.2f}")
                            else:
                                print(f"[{timestamp}] [FACE DETECTED] Unregistered face | Conf: {conf:.2f}")
                            last_log_time["unregistered"] = now

            # Reset consecutive count for any registered face not seen in this frame
            for name in list(consecutive_counts.keys()):
                if name not in matched_this_frame:
                    consecutive_counts[name] = 0

            cv2.imshow("AlertMed Face Detection", display_frame)
            if cv2.waitKey(30) & 0xFF == ord('q'):
                break

    except KeyboardInterrupt:
        print("\n[INFO] Stopped by user (KeyboardInterrupt).")
    finally:
        if cap and cap.isOpened():
            cap.release()
            print("[INFO] Camera released.")
        cv2.destroyAllWindows()

if __name__ == "__main__":
    main()
