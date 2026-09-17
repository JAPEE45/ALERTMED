import cv2
import numpy as np
import os
import sys
import time
import urllib.request
import urllib.error
import json
import argparse

SERVER_URL = "http://127.0.0.1:3000"

def open_webcam(cam_index):
    """Opens a webcam with DirectShow for fast startup on Windows."""
    print(f"[INFO] Opening Webcam index {cam_index}...")
    cap = cv2.VideoCapture(cam_index, cv2.CAP_DSHOW)
    if not cap.isOpened():
        cap = cv2.VideoCapture(cam_index)
    return cap

def get_server_schedule_status():
    """Checks if a schedule is currently up on the Node.js server."""
    try:
        req = urllib.request.Request(f"{SERVER_URL}/api/status", headers={'User-Agent': 'AlertMed-FaceRecog'}, method='GET')
        with urllib.request.urlopen(req, timeout=1.0) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            state = data.get("systemState", {})
            return state.get("step", "IDLE"), state.get("pendingQueue", [])
    except Exception:
        # If server is unreachable, assume active checking so we don't miss anything
        return "UNKNOWN", []

def register_face_direct(frame, face, recognizer, name):
    """Saves a face feature vector to registered_faces/{name}.npy."""
    aligned = recognizer.alignCrop(frame, face)
    feature = recognizer.feature(aligned)
    os.makedirs("registered_faces", exist_ok=True)
    save_path = os.path.join("registered_faces", f"{name}.npy")
    np.save(save_path, feature)
    print(f"[INFO] Successfully registered and saved '{name}' to {save_path}!")
    return feature

def main():
    parser = argparse.ArgumentParser(description="AlertMed Face Recognition Background & Headless Service")
    parser.add_argument("--gui", action="store_true", help="Open visual camera window (panel)")
    parser.add_argument("--cam", type=int, default=0, help="Camera index (default: 0, fallback: 1)")
    parser.add_argument("--register", type=str, default="", help="Register face for given name from camera, then exit")
    args = parser.parse_args()

    show_gui = args.gui
    target_name_to_register = args.register.strip()

    print("[INFO] =========================================================")
    print(f"[INFO] AlertMed Face Recognition Service starting...")
    print(f"[INFO] Mode: {'GUI Window (Panel Active)' if show_gui else 'Headless Background (Direct Video Stream)'}")
    print("[INFO] =========================================================")

    detector_path = "face_detection_yunet.onnx"
    recognizer_path = "face_recognition_sface.onnx"

    if not os.path.exists(detector_path) or not os.path.exists(recognizer_path):
        print("[ERROR] Model files not found. Ensure .onnx files are in the current directory.")
        return

    # Initialize YuNet detector (strict threshold: 0.60) and SFace recognizer
    detector = cv2.FaceDetectorYN.create(detector_path, "", (640, 480), score_threshold=0.60)
    recognizer = cv2.FaceRecognizerSF.create(recognizer_path, "")

    # Load registered faces
    registered_faces = []
    if os.path.exists("registered_faces"):
        for file in os.listdir("registered_faces"):
            if file.endswith(".npy"):
                name = os.path.splitext(file)[0]
                feature = np.load(os.path.join("registered_faces", file))
                registered_faces.append({"name": name, "feature": feature})
    print(f"[INFO] Loaded {len(registered_faces)} registered face(s): {[f['name'] for f in registered_faces]}")

    # Open Camera
    current_cam_idx = args.cam
    cap = open_webcam(current_cam_idx)
    if not cap.isOpened():
        fallback_idx = 1 if current_cam_idx == 0 else 0
        print(f"[INFO] Camera {current_cam_idx} failed. Trying Camera {fallback_idx}...")
        current_cam_idx = fallback_idx
        cap = open_webcam(current_cam_idx)

    if not cap.isOpened():
        print("[ERROR] Could not open any webcam. Please verify camera connection.")
        return

    print(f"[INFO] Webcam successfully opened on index {current_cam_idx}.")

    # --- CLI Registration Mode ---
    if target_name_to_register:
        print(f"[INFO] Registration mode active for: '{target_name_to_register}'. Looking at camera...")
        attempts = 0
        while attempts < 30:
            ret, frame = cap.read()
            if ret and frame is not None:
                h, w = frame.shape[:2]
                detector.setInputSize((w, h))
                _, faces = detector.detect(frame)
                if faces is not None and len(faces) == 1:
                    f = faces[0]
                    w_box, h_box = int(f[2]), int(f[3])
                    if w_box >= 80 and h_box >= 80 and f[14] >= 0.70:
                        register_face_direct(frame, f, recognizer, target_name_to_register)
                        cap.release()
                        return
            time.sleep(0.1)
            attempts += 1
        print("[ERROR] Could not detect a single clear face to register. Please try again.")
        cap.release()
        return

    # --- Accessible Face Recognition Settings (Blind/Visually Impaired Friendly) ---
    # The user is blind, so NO gaze/eye-contact checks.
    # Instead, PROXIMITY (face size) is the primary gate:
    #   - At desk distance (~2-3 ft): face is ~100-130px wide → REJECTED
    #   - Approaching dispenser (~8-14 inches): face is ~180-300px wide → ACCEPTED
    COSINE_THRESHOLD = 0.50           # Identity match (size filter handles proximity gating)
    MIN_FACE_WIDTH = 150             # Only close-up faces pass (rejects desk-distance 100-130px faces)
    MIN_FACE_HEIGHT = 150            # Must be close to dispenser camera
    REQUIRED_CONSECUTIVE_FRAMES = 3  # Stable: 3 consecutive frames (~150ms) to confirm
    consecutive_counts = {reg["name"]: 0 for reg in registered_faces}

    frame_counter = 0
    last_status_check_time = 0
    server_step = "UNKNOWN"
    pending_pins = []

    print("[INFO] Direct webcam stream ready. Prediction will activate when a schedule is up...")

    while True:
        now = time.time()

        # Check server schedule status every 1.0 second
        if now - last_status_check_time > 1.0:
            server_step, pending_pins = get_server_schedule_status()
            last_status_check_time = now

        # Only activate prediction when a schedule is due ("WAITING_FOR_FACE")
        is_schedule_up = (server_step == "WAITING_FOR_FACE")
        if not show_gui and not is_schedule_up:
            # Idle cleanly — reset consecutive counters so stale counts don't linger
            for k in consecutive_counts:
                consecutive_counts[k] = 0
            time.sleep(0.5)
            continue

        ret, frame = cap.read()
        if not ret or frame is None:
            time.sleep(0.05)
            continue

        frame_counter += 1
        h, w = frame.shape[:2]

        scale = 1.0
        if w > 1280:
            scale = 1280.0 / w
            detect_frame = cv2.resize(frame, (0, 0), fx=scale, fy=scale)
        else:
            detect_frame = frame

        dh, dw = detect_frame.shape[:2]
        detector.setInputSize((dw, dh))
        _, faces = detector.detect(detect_frame)

        face_count = len(faces) if faces is not None else 0
        current_frame_matches = set()
        verified_match_to_report = None
        best_verified_score = 0.0

        # Debug log every 10 frames to show what's being detected
        if frame_counter % 10 == 0:
            if face_count == 0:
                print(f"[DEBUG F#{frame_counter}] No faces detected in frame")
            else:
                for fi, f in enumerate(faces):
                    fx, fy, fw_b, fh_b = int(f[0]), int(f[1]), int(f[2]), int(f[3])
                    fc = float(f[14])
                    is_edge = fx < 15 or (fx + fw_b) > (w - 15)
                    too_small = fw_b < MIN_FACE_WIDTH or fh_b < MIN_FACE_HEIGHT
                    status = "OK"
                    if is_edge:
                        status = "REJECTED:edge"
                    elif too_small:
                        status = f"REJECTED:small({fw_b}x{fh_b}<{MIN_FACE_WIDTH}x{MIN_FACE_HEIGHT})"
                    elif fc < 0.55:
                        status = f"REJECTED:lowConf({fc:.2f})"
                    print(f"[DEBUG F#{frame_counter}] Face#{fi}: {fw_b}x{fh_b} conf={fc:.2f} [{status}]")

        if faces is not None:
            for face in faces:
                scaled_face = face.copy() if scale != 1.0 else face
                if scale != 1.0:
                    scaled_face[:14] = scaled_face[:14] / scale

                box = scaled_face[:4].astype(int)
                w_box, h_box = box[2], box[3]
                conf = float(scaled_face[14])

                # 1. Edge-clipping filter: must be in the camera view, not cut off at screen borders
                if box[0] < 15 or (box[0] + w_box) > (w - 15):
                    continue

                # 2. Distance filter: dispenser proximity (reject distant background persons)
                if w_box < MIN_FACE_WIDTH or h_box < MIN_FACE_HEIGHT or conf < 0.55:
                    continue

                # 3. Accessibility note: The user does NOT need to gaze at the camera lens (blind/visually impaired friendly).
                # SFace extracts facial structure regardless of gaze direction or eye focus.

                # 4. Extract feature vector with SFace
                try:
                    aligned_face = recognizer.alignCrop(frame, scaled_face)
                    feature = recognizer.feature(aligned_face)

                    best_name = None
                    best_score = 0.0
                    for reg in registered_faces:
                        score = recognizer.match(feature, reg["feature"], cv2.FaceRecognizerSF_FR_COSINE)
                        if score > best_score:
                            best_score = score
                            best_name = reg["name"]

                    # 5. Check against similarity threshold
                    if best_name and best_score >= COSINE_THRESHOLD:
                        current_frame_matches.add(best_name)
                        consecutive_counts[best_name] = consecutive_counts.get(best_name, 0) + 1
                        print(f"[STREAM] Registered face '{best_name}' detected ({consecutive_counts[best_name]}/{REQUIRED_CONSECUTIVE_FRAMES}) | Score: {best_score:.2f} | Conf: {conf:.2f} | Size: {w_box}x{h_box}")

                        if consecutive_counts[best_name] >= REQUIRED_CONSECUTIVE_FRAMES:
                            verified_match_to_report = best_name
                            best_verified_score = best_score
                except Exception:
                    pass

        # Reset consecutive count for any registered name not matched in this frame
        for name in list(consecutive_counts.keys()):
            if name not in current_frame_matches:
                consecutive_counts[name] = 0

        # When confirmed across consecutive frames, report to server!
        if verified_match_to_report:
            print(f"[STEP 2/3: FACE DETECTED] Confirmed registered face: '{verified_match_to_report}'! (Score: {best_verified_score:.2f}) | Will dispense now?: NO (Waiting for ultrasonic proximity)")
            try:
                payload = json.dumps({"name": verified_match_to_report, "confidence": float(best_verified_score)}).encode('utf-8')
                req = urllib.request.Request(
                    f"{SERVER_URL}/api/verify-face",
                    data=payload,
                    headers={'Content-Type': 'application/json'},
                    method='POST'
                )
                with urllib.request.urlopen(req, timeout=2) as response:
                    res_data = json.loads(response.read().decode('utf-8'))
                    print(f"[STEP 2/3: FACE VERIFIED] Server confirmed face: '{verified_match_to_report}'! Advance to Step 3/3.")

                # If headless, we are done with face detection! Release webcam and exit cleanly.
                if not show_gui:
                    print("[INFO] Releasing webcam stream. Waiting for Ultrasonic object detection within 20 inches (50.8 cm)...")
                    break
            except urllib.error.HTTPError as http_err:
                try:
                    err_body = json.loads(http_err.read().decode('utf-8'))
                    print(f"[INFO] Server response: {err_body.get('message', 'No schedule up.')}")
                except Exception:
                    print(f"[INFO] Server: No schedule is currently up.")
            except Exception as err:
                print(f"[WARNING] Server communication error: {err}")

            # Reset counts after sending
            for k in consecutive_counts:
                consecutive_counts[k] = 0

        if show_gui:
            status_text = f"SCHEDULE: {server_step} | PREDICTION: {'ACTIVE' if is_schedule_up else 'IDLE'}"
            cv2.rectangle(frame, (0, 0), (w, 36), (0, 150, 0) if is_schedule_up else (50, 50, 50), -1)
            cv2.putText(frame, status_text, (10, 25), cv2.FONT_HERSHEY_SIMPLEX, 0.65, (255, 255, 255), 2)
            cv2.imshow("AlertMed - Live Video Stream", frame)
            key = cv2.waitKey(1) & 0xFF
            if key == ord('q'):
                break
        else:
            time.sleep(0.03)

    cap.release()
    if show_gui:
        cv2.destroyAllWindows()

if __name__ == "__main__":
    main()
