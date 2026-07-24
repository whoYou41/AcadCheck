# EMEET SmartCam Setup Guide

Run the AcadCheck scanner using a **Raspberry Pi** with an **EMEET SmartCam** (USB webcam) connected, or any Linux machine with the SmartCam attached. The SmartCam streams 4K/1080p frames over USB to a Flask server that the scanner page polls for live frames and captures.

## What You Need

- Raspberry Pi (3B+ or newer, or Pi Zero 2 W) **or** any Linux laptop/PC
- **EMEET SmartCam** USB webcam
- USB 2.0 cable (the one included with the SmartCam)
- MicroSD card with Raspberry Pi OS (Bookworm) — if using a Pi
- Same WiFi/Ethernet network for the Pi/PC running the server and the device running AcadCheck
- (Recommended) A desktop stand or gooseneck mount to position the camera above the answer sheet

---

## Step 1 — Prepare the Pi (or Linux PC)

Flash Raspberry Pi OS using [Raspberry Pi Imager](https://www.raspberrypi.com/software/). Before flashing, open **Advanced Options** and:
- Enable **SSH** (use password authentication)
- Set a **hostname** (e.g. `acadcam`) and your WiFi SSID/password

Boot the Pi, plug in the **EMEET SmartCam** via USB, then SSH in:
```bash
ssh pi@acadcam.local
# default password: raspberry
```

Update:
```bash
sudo apt update && sudo apt upgrade -y
```

> **Linux PC alternative:** Skip flashing — just SSH into your existing PC or use it directly. The steps below are the same.

---

## Step 2 — Verify the EMEET SmartCam Is Detected

Plug the **EMEET SmartCam** into a USB port on the Pi (or PC), then verify it is recognized:

```bash
ls /dev/video*
# Should show /dev/video0 and possibly /dev/video1
```

You can also test it with `ffmpeg` (preinstalled on Raspberry Pi OS) or `cheese`:

```bash
# Quick preview test
ffplay /dev/video0
# (press 'q' to quit)
```

If `/dev/video0` does not appear:

1. Unplug and re-plug the SmartCam into a different USB port.
2. Confirm the cable and port are working (try another USB device).
3. Check the camera is recognized:
   ```bash
   lsusb
   # EMEET SmartCam should appear in the list
   ```
4. Ensure no other app is holding the camera:
   ```bash
   sudo lsof /dev/video0 /dev/video1
   # Kill the process if found:
   sudo kill -9 <PID>
   ```
5. Ensure your user has permission to access the camera:
   ```bash
   sudo usermod -aG video $USER
   # Log out and back in, or reboot
   ```

> **Tip:** The EMEET SmartCam uses a standard UVC (USB Video Class) driver — no extra driver installation is needed on Raspberry Pi OS Bookworm.

> **Note:** The SmartCam may expose two video nodes (`/dev/video0` and `/dev/video1`). The server automatically tries both and uses the one that opens successfully.

---

## Step 3 — Install the Camera Server

```bash
sudo apt install -y python3-pip python3-venv ffmpeg
mkdir -p ~/camera-server && cd ~/camera-server
python3 -m venv venv
source venv/bin/activate
pip install --upgrade pip setuptools wheel
pip install -r requirements.txt
```

> **Note:** `v4l2-ctl` is used by `camera-server.py` to pre-configure the SmartCam format before OpenCV opens it. It is included with `ffmpeg` on Raspberry Pi OS. If missing: `sudo apt install -y v4l-utils`.

> **Python 3.13 note:** If `pip install -r requirements.txt` fails with `AttributeError: module 'pkgutil' has no attribute 'ImpImporter'`, upgrade pip/setuptools first:
> ```bash
> pip install --upgrade pip setuptools wheel
> ```
> If that still fails, install NumPy system-wide before retrying:
> ```bash
> sudo apt install -y python3-numpy
> ```

Copy `camera-server.py` from this project into `~/camera-server/`.

Before first run, configure `camera-server.py` for the **EMEET SmartCam**:

```python
# EMEET SmartCam config — edit these in camera-server.py:
CAMERA_INDEX = 0
STREAM_FPS   = 20
JPEG_QUALITY = 100
SMARTCAM_WIDTH  = 3840   # 4K capture (3840×2160)
SMARTCAM_HEIGHT = 2160
```

> **Warning — 4K on low-power devices:** 3840×2160 requires significant bandwidth and memory.
> On Raspberry Pi 4 with 2 GB RAM or any 10/100 Mbps Ethernet, the stream may lag.
> Each 4K raw frame is ~25 MB. If laggy, reduce to 1920×1080 or 1280×720.

Test it:
```bash
python camera-server.py
```
Find the Pi/PC's IP:
```bash
hostname -I
```

From another device on the same network, open:
- `http://<ip>:5000/` — live view
- `http://<ip>:5000/capture` — single photo
- `http://<ip>:5000/test.jpg` — single frame (diagnostic)
- `http://<ip>:5000/status` — diagnostics

> **If the stream shows "Stream error" or stays black:**
> 1. Open `/status` — if `camera_initialized` is `false`, the camera is not opening. Check terminal for `ERROR:` messages.
> 2. Open `/test.jpg` — if this returns an image, the camera works but streaming may be timing out. If it also fails, the camera is not delivering frames.
> 3. Check the terminal for `STREAM WARNING: waiting for first frame...` — if this repeats, `read_frame()` is returning `None`. Ensure the user is in the `video` group and no other app is using `/dev/video0`.

Stop the server with `Ctrl+C` when done testing.

---

## Step 4 — Auto-Start on Boot (systemd)

Create a service file:
```bash
sudo nano /etc/systemd/system/camera-server.service
```

Paste:
```ini
[Unit]
Description=AcadCheck Camera Server (EMEET SmartCam)
After=network.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/camera-server
ExecStart=/home/pi/camera-server/venv/bin/python /home/pi/camera-server/camera-server.py
Restart=always
RestartSec=5
Environment=PATH=/home/pi/camera-server/venv/bin:/usr/bin:/bin

[Install]
WantedBy=multi-user.target
```

Enable and start:
```bash
sudo systemctl daemon-reload
sudo systemctl enable camera-server
sudo systemctl start camera-server
```

Check it's running:
```bash
sudo systemctl status camera-server
```

---

## Step 5 — Connect AcadCheck

1. In AcadCheck, go to **Exam Scanner**.
2. Set **Camera Base URL** to:
   ```
   http://<ip>:5000
   ```
   Example: `http://192.168.1.50:5000`
3. Click **Test Connection** — you should see `✅ Camera connected and responding!`
4. Click **Start Camera** — live feed appears.
5. Click **Scan & Grade** to capture and process.

> **Do not** add `/stream` or `/capture` to the URL. The app handles that automatically.

> **Camera tip:** Position the EMEET SmartCam directly above the answer sheet (perpendicular, ~30–40 cm high). Good lighting reduces shadows and improves OMR accuracy.

---

## Maximizing Scan Quality

### Camera-side settings
- **Resolution:** 1920×1080 (recommended for Raspberry Pi 4 2GB). 3840×2160 (4K) is supported but may lag on lower RAM devices.
- **JPEG quality:** 95 (default in `camera-server.py`). Increase to `98` if network bandwidth allows; decrease to `85` if stream is laggy.
- **FPS:** 10 (default for Pi 4 2GB). Use `15` only on more powerful devices or Ethernet.
- **Autofocus/Auto-exposure/Auto-white-balance:** Enabled by default in `camera-server.py`. If the SmartCam hunts for focus, disable autofocus and set a fixed focus distance.
- **Buffer size:** 1 frame (minimizes latency between capture and stream).
- **Temporal smoothing:** Lightweight EMA smoothing is applied to the stream to reduce jitter and USB webcam noise. Adjust `SMOOTH_ALPHA` in `camera-server.py` (default `0.8`; higher = smoother but slightly more lag).
- **Denoising:** Denoising is **skipped for the live stream** by default to keep CPU usage low on the Pi. It is **enabled for captures** with stronger settings to reduce noise for OMR. Tune with `DENOISE_STREAM` and `DENOISE_CAPTURE` in `camera-server.py`.
- **Sharpening:** Captures are lightly sharpened after denoising to make bubble edges crisper for OMR detection. This is applied automatically to `/capture`, `/test.jpg`, and `/detect-sequence`.
- **Capture warm-up:** The `/capture` endpoint discards a few frames first so autofocus/exposure can settle before saving the image.
- **Anti-banding:** The server requests MJPG from the SmartCam to reduce flicker under artificial lighting.

### Physical setup
- Use the **desktop stand** or a **gooseneck mount** to keep the camera steady.
- Light the answer sheet evenly from above or the side. Avoid backlighting from windows.
- Keep the SmartCam lens clean — smudges cause blurry captures.
- Maintain a consistent camera angle and distance across exams.

### App-side preprocessing
- The scanner page now resizes captures to **2048 px max dimension** (was 1024), preserving more detail for OMR detection while keeping upload size reasonable.
- Client-side grayscale is preserved; backend handles adaptive thresholding.

If you still get poor OMR results after these changes, check:
1. Is the answer sheet flat and fully visible in the frame?
2. Is there strong shadow or glare on the bubbles?
3. Are you using the correct answer key for that exam?

---

## Adjusting Quality

Edit `camera-server.py`, then restart (`sudo systemctl restart camera-server`):

```python
CAMERA_INDEX = 0          # Change to 1 if SmartCam is not /dev/video0
STREAM_FPS   = 10         # Lower to 8 if network is slow (default 10 for Pi 4 2GB)
JPEG_QUALITY = 95         # Lower = faster (try 70), higher = sharper (try 98)
SMOOTH_ALPHA = 0.8        # Stream smoothing (0 = none, 0.9 = very smooth)
DENOISE_STREAM = False    # Set True to denoise stream (CPU heavy on Pi)
DENOISE_CAPTURE = True    # Set False for raw capture frames
```

**EMEET SmartCam native resolution is 3840×2160 (4K).** On Raspberry Pi 4 with 2GB RAM, 4K may cause lag. The recommended default in `camera-server.py` is **1920×1080**.

To use 4K (if your device can handle it):

```python
SMARTCAM_WIDTH  = 3840
SMARTCAM_HEIGHT = 2160
```

If streaming is choppy, drop to 1920×1080:

```python
SMARTCAM_WIDTH  = 1920
SMARTCAM_HEIGHT = 1080
```

If still choppy, drop to 1280×720:

```python
SMARTCAM_WIDTH  = 1280
SMARTCAM_HEIGHT = 720
```

> **Note:** 4K streaming requires significant bandwidth and CPU. If you see frame drops, reduce `STREAM_FPS` to `8` or lower the resolution. Using Ethernet instead of WiFi is strongly recommended for 4K.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `/dev/video0` not found | Unplug/re-plug SmartCam; try different USB port; run `lsusb` to confirm it is detected |
| SmartCam not in `lsusb` | Cable may be power-only — use the included USB 2.0 cable; try a powered USB hub |
| `/capture` returns 503 | Another app is using the camera — run `sudo lsof /dev/video0 /dev/video1`, kill the process, then retry |
| Stream is choppy / low FPS | Lower `STREAM_FPS` to 8 and `JPEG_QUALITY` to 70; use 1280×720; ensure `DENOISE_STREAM = False`; use Ethernet |
| Blurry captures | Clean the SmartCam lens; ensure it is focused (autofocus may hunt in low light — add lighting) |
| Can't reach `http://<ip>:5000` | Confirm both devices are on the same network; check IP with `hostname -I`; disable firewall on the Pi/PC |
| Camera works locally but not from browser | Check CORS — `camera-server.py` sets `Access-Control-Allow-Origin: *`; if using a reverse proxy, allow `/stream` and `/capture` |
| `pip install` fails with cv2 error | Install OpenCV system-wide first: `sudo apt install -y python3-opencv`, then retry pip |
| Stream shows black screen / 0 frames | Check terminal for "ERROR: Cannot open camera"; ensure user `pi`/`acadcheck` is in `video` group: `sudo usermod -aG video $USER`; reboot or re-login |
| `/stream` image never appears / Stream error | Open `/status` — if `camera_initialized` is false, camera is not opening; try `CAMERA_INDEX = 0`; open `/test.jpg` to verify single-frame capture works; check terminal for `OpenCV failed to open` or `Resolution is 0x0` |
| `/test.jpg` also fails | Camera is not delivering frames — check permissions, cable, `lsusb`, and whether another process holds `/dev/video0` or `/dev/video1` |
| Terminal shows "STREAM WARNING: waiting for first frame" | `read_frame()` keeps returning `None` — likely a permissions issue or camera busy; ensure user is in `video` group and no other app is using the camera |
| Camera opens but resolution is 0x0 | GStreamer backend may be failing format negotiation; the server now uses `v4l2-ctl` to pre-set MJPG format. If still 0x0, try `sudo apt install -y v4l-utils` and reboot |
| Stream still looks noisy/jittery | Increase `SMOOTH_ALPHA` to `0.85` or `0.9`; ensure good lighting; clean the SmartCam lens |
| Stream feels laggy after smoothing | Lower `SMOOTH_ALPHA` to `0.6` or set `SMOOTH_ENABLED = False` |
| Capture sometimes slightly blurred | Increase `CAPTURE_WARMUP_FRAMES` to `5`; ensure autofocus is enabled and the sheet is well-lit |

---

## Files

```
raspberry-pi-camera/
├── camera-server.py      # Flask server — runs on Pi/PC, serves SmartCam frames
├── requirements.txt      # Python dependencies
├── index.html            # Browser test page
└── SETUP_GUIDE.md        # This file
```

> **Diagnostic endpoints:**
> - `/status` — JSON with camera state, resolution, frame count
> - `/test.jpg` — single JPEG frame for quick camera verification
