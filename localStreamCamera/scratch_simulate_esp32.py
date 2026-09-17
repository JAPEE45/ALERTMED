import websocket
import cv2
import numpy as np
import time

ws = websocket.WebSocket()
ws.connect("ws://localhost:5000/stream")

# create a dummy image
img = np.zeros((240, 320, 3), dtype=np.uint8)
cv2.putText(img, "ESP32", (100, 120), cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 0, 255), 2)
ret, buf = cv2.imencode('.jpg', img)

for _ in range(50):
    ws.send_binary(buf.tobytes())
    time.sleep(0.1)

ws.close()
