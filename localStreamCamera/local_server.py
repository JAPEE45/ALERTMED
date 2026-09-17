import cv2
import numpy as np
import time
import os
import multiprocessing as mp
import queue
import traceback
import logging
import urllib.request
import urllib.error
import json
from flask import Flask
from flask_sock import Sock

# Disable Flask default logging to prevent console spam
log = logging.getLogger('werkzeug')
log.setLevel(logging.ERROR)

app = Flask(__name__)
sock = Sock(app)

# Global variables for models (will be initialized in the worker process)
face_detector = None
face_recognizer = None
registered_faces = []
last_recognition_time = {}
cooldown_seconds = 3.0

# Multiprocessing queue to decouple receiving frames from processing them.
# Small maxsize to drop old frames if processing falls behind.
frame_queue = None

fps_counter = {"count": 0, "start_time": time.time()}

def init_models():
    global face_detector, face_recognizer, registered_faces
    print("[INFO] Loading Face Detection (YuNet) and Recognition (SFace) models...")
    try:
        if os.path.exists("face_detection_yunet.onnx") and os.path.exists("face_recognition_sface.onnx"):
            # Lowered score_threshold to 0.35 for reliable detection
            face_detector = cv2.FaceDetectorYN.create("face_detection_yunet.onnx", "", (320, 320), score_threshold=0.35)
            face_recognizer = cv2.FaceRecognizerSF.create("face_recognition_sface.onnx", "")
            
            if os.path.exists("registered_faces"):
                for file in os.listdir("registered_faces"):
                    if file.endswith(".npy"):
                        name = os.path.splitext(file)[0]
                        feature = np.load(os.path.join("registered_faces", file))
                        registered_faces.append({"name": name, "feature": feature})
            print(f"[INFO] Loaded {len(registered_faces)} registered faces.")
        else:
            print("[WARNING] Model files not found. Face detection will run without recognition if disabled.")
            # We can still initialize detector if it exists
            if os.path.exists("face_detection_yunet.onnx"):
                face_detector = cv2.FaceDetectorYN.create("face_detection_yunet.onnx", "", (320, 320), score_threshold=0.35)
            else:
                print("[ERROR] face_detection_yunet.onnx is completely missing! Detection cannot run.")
    except Exception as e:
        print(f"[ERROR] Could not load face models: {e}")
        print("[INFO] Disabling face recognition.")
        face_detector = None
        face_recognizer = None

def process_frames_worker(q):
    init_models()
    global face_detector, face_recognizer, registered_faces, last_recognition_time
    
    print("[INFO] Frame processing process started.")
    while True:
        try:
            # Block until a frame is available
            data = q.get(timeout=1.0)
        except queue.Empty:
            continue
            
        try:
            # 1. Decode JPEG
            nparr = np.frombuffer(data, np.uint8)
            frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
            
            if frame is None:
                print("[WARNING] Failed to decode frame")
                continue
                
            h, w = frame.shape[:2]
            
            # 2. Run detection
            if face_detector is not None:
                scale = 1.0
                # Scale down to 320 width (reverted from 160 to maintain recognition accuracy)
                if w > 320:
                    scale = 320.0 / w
                    small_frame = cv2.resize(frame, (0, 0), fx=scale, fy=scale)
                else:
                    small_frame = frame
                    
                sh, sw = small_frame.shape[:2]
                face_detector.setInputSize((sw, sh))
                _, faces = face_detector.detect(small_frame)
                
                if faces is not None:
                    # Print message if face detected to fulfill requirements
                    print(f"[ALERT] Face Detected! (Count: {len(faces)})")
                    
                    for face in faces:
                        scaled_face = face.copy()
                        scaled_face[:14] = scaled_face[:14] / scale
                        
                        # Recognition
                        if face_recognizer is not None:
                            try:
                                aligned_face = face_recognizer.alignCrop(frame, scaled_face)
                                feature = face_recognizer.feature(aligned_face)
                                
                                name = "Unknown"
                                match_score = 0
                                for reg in registered_faces:
                                    score = face_recognizer.match(feature, reg["feature"], cv2.FaceRecognizerSF_FR_COSINE)
                                    if score >= 0.50:
                                        name = reg["name"]
                                        match_score = score
                                        break
                                        
                                now = time.time()
                                if name != "Unknown":
                                    if name not in last_recognition_time or (now - last_recognition_time[name]) > cooldown_seconds:
                                        print(f"[ALERT] Registered Face Detected: {name}! (Confidence: {match_score:.2f})")
                                        last_recognition_time[name] = now
                                        
                                        # Verify face against active schedule on Node.js server
                                        try:
                                            payload = json.dumps({"name": name, "confidence": float(match_score)}).encode('utf-8')
                                            req = urllib.request.Request(
                                                'http://127.0.0.1:3000/api/verify-face',
                                                data=payload,
                                                headers={'Content-Type': 'application/json'},
                                                method='POST'
                                            )
                                            with urllib.request.urlopen(req, timeout=2) as response:
                                                res_data = json.loads(response.read().decode('utf-8'))
                                                print(f"[SUCCESS] {res_data.get('message', 'Face verified! Waiting for ultrasonic sensor.')}")
                                        except urllib.error.HTTPError as http_err:
                                            try:
                                                err_body = json.loads(http_err.read().decode('utf-8'))
                                                print(f"[INFO] Server Response: {err_body.get('message', 'No schedule up. Face not saved.')}")
                                            except Exception:
                                                print(f"[INFO] Server returned {http_err.code}: No schedule is up. Face detection not saved.")
                                        except Exception as err:
                                            print(f"[WARNING] Failed to reach server: {err}")
                                else:
                                    if "Unknown" not in last_recognition_time or (now - last_recognition_time["Unknown"]) > cooldown_seconds:
                                        print(f"[ALERT] Unknown Face Detected! (Ignored - only registered faces authorized)")
                                        last_recognition_time["Unknown"] = now
                            except Exception as e:
                                pass # Ignore recognition errors on edge cases

        except Exception as e:
            print(f"[ERROR] Error processing frame: {e}")
            traceback.print_exc()
            
        # Tiny pause to let the WebSocket networking thread receive frames
        time.sleep(0.01)

@app.route('/')
def index():
    return "WebSocket Video Streaming Server is running. ESP32 should connect to ws://[ip]:5050/stream", 200

@sock.route('/stream')
def stream(ws):
    global fps_counter
    print("[INFO] ESP32 Connected via WebSocket!")
    
    while True:
        try:
            # Block until a binary frame is received
            data = ws.receive()
            if not data:
                continue
                
            # FPS Counting
            fps_counter["count"] += 1
            now = time.time()
            elapsed = now - fps_counter["start_time"]
            if elapsed >= 5.0:
                fps = fps_counter["count"] / elapsed
                print(f"[INFO] Receiving stream at ~{fps:.1f} FPS")
                fps_counter["count"] = 0
                fps_counter["start_time"] = now

            # Put frame in queue. Drop oldest if full.
            try:
                frame_queue.put_nowait(data)
            except queue.Full:
                try:
                    frame_queue.get_nowait()
                    frame_queue.put_nowait(data)
                except (queue.Empty, queue.Full):
                    pass
                
        except Exception as e:
            print(f"[WARNING] WebSocket connection closed: {e}")
            break

if __name__ == "__main__":
    # Create the global multiprocessing queue
    frame_queue = mp.Queue(maxsize=2)
    
    # Start the frame processing process instead of a thread to avoid GIL blocking
    processor = mp.Process(target=process_frames_worker, args=(frame_queue,))
    processor.daemon = True
    processor.start()
    
    # We do NOT call init_models() here in the main process anymore, 
    # as the worker process calls it independently.
    
    # Run the Flask HTTP server directly on the main thread
    print("[INFO] Starting WebSocket Server on port 5050...")
    print("[INFO] Server is running headlessly. Face detection alerts will be printed here.")
    app.run(host="0.0.0.0", port=5050, use_reloader=False, threaded=True)
