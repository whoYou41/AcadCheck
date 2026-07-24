from flask import Flask, Response, jsonify, send_from_directory, request
import cv2
import time
import threading
from datetime import datetime, timezone
import numpy as np
import subprocess
import os
import base64
import re
import json

_V4L2_BACKEND = getattr(cv2, 'CAP_V4L2', None)

app = Flask(__name__)

# ---- Config ----
CAMERA_INDEX = 0
STREAM_FPS   = 20
JPEG_QUALITY = 100
PORT         = 5000
HOST         = '0.0.0.0'
SMARTCAM_WIDTH  = 3840
SMARTCAM_HEIGHT = 2160

SMOOTH_ALPHA = 0.18
SMOOTH_ENABLED = False
DENOISE_STREAM = False
DENOISE_CAPTURE = True
CAPTURE_WARMUP_FRAMES = 2

TESSERACT_CMD = 'tesseract'
TESSERACT_LANG = 'eng'

def _check_tesseract():
    try:
        result = subprocess.run([TESSERACT_CMD, '--version'], capture_output=True, text=True, timeout=5)
        if result.returncode == 0:
            print('Tesseract found: {}'.format(result.stdout.splitlines()[0]))
            return True
    except Exception:
        pass
    print('WARNING: tesseract not found. Install with: sudo apt install -y tesseract-ocr')
    return False

TESSERACT_AVAILABLE = _check_tesseract()

camera = None
camera_lock = threading.Lock()
frame_count = 0
start_time = time.time()
_last_smooth_frame = None

# ---- Camera Helpers ----

def _try_set_resolution(cap, width, height):
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
    time.sleep(0.3)
    actual_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    actual_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    return actual_w, actual_h

def _v4l2_set_format(device, width, height, pixelformat='MJPG'):
    try:
        subprocess.run(
            ['v4l2-ctl', '--device', device,
             '--set-fmt-video=width={},height={},pixelformat={}'.format(width, height, pixelformat)],
            check=False, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
    except Exception:
        pass

def _v4l2_get_current_format(device):
    try:
        out = subprocess.check_output(
            ['v4l2-ctl', '--device', device, '--get-fmt-video'],
            stderr=subprocess.PIPE, text=True,
        )
        width = height = 0
        fmt = ''
        for line in out.splitlines():
            line = line.strip()
            if 'Width' in line:
                parts = line.split(':')
                if len(parts) > 1:
                    width = int(parts[1].strip())
            elif 'Height' in line:
                parts = line.split(':')
                if len(parts) > 1:
                    height = int(parts[1].strip())
            elif 'Pixel Format' in line:
                parts = line.split(':')
                if len(parts) > 1:
                    fmt = parts[1].strip().strip("'")
        return width, height, fmt
    except Exception:
        return 0, 0, ''

def set_camera_props(cap):
    cap.set(cv2.CAP_PROP_FPS, STREAM_FPS)
    cap.set(cv2.CAP_PROP_BUFFERSIZE, 2)
    try:
        cap.set(cv2.CAP_PROP_AUTOFOCUS, 1)
        cap.set(cv2.CAP_PROP_AUTO_EXPOSURE, 0.75)
        cap.set(cv2.CAP_PROP_AUTO_WB, 1)
    except Exception:
        pass
    try:
        fourcc = cv2.VideoWriter_fourcc(*'MJPG')
        cap.set(cv2.CAP_PROP_FOURCC, fourcc)
    except Exception:
        pass
    w, h = _try_set_resolution(cap, SMARTCAM_WIDTH, SMARTCAM_HEIGHT)
    print('Camera resolution: {}x{}'.format(w, h))

def init_camera():
    global camera
    resolutions = [
        (SMARTCAM_WIDTH, SMARTCAM_HEIGHT),
        (1920, 1080),
        (1280, 720),
    ]
    for idx in [CAMERA_INDEX, 1]:
        device = '/dev/video{}'.format(idx)
        if not os.path.exists(device):
            continue
        print('Trying {} (index {})'.format(device, idx))
        for width, height in resolutions:
            _v4l2_set_format(device, width, height)
            w_before, h_before, fmt_before = _v4l2_get_current_format(device)
            print('  v4l2 current format before OpenCV: {}x{} {}'.format(w_before, h_before, fmt_before))
            if _V4L2_BACKEND is not None:
                cap = cv2.VideoCapture(idx, _V4L2_BACKEND)
            else:
                cap = cv2.VideoCapture(idx)
            if not cap.isOpened():
                print('  OpenCV failed to open index {}'.format(idx))
                break
            camera = cap
            print('  Camera opened at index {} ({})'.format(idx, device))
            set_camera_props(camera)
            w_after = int(camera.get(cv2.CAP_PROP_FRAME_WIDTH))
            h_after = int(camera.get(cv2.CAP_PROP_FRAME_HEIGHT))
            print('  OpenCV reports resolution: {}x{}'.format(w_after, h_after))
            if w_after > 0 and h_after > 0:
                return True
            print('  Resolution is 0x{} after init, releasing and trying next resolution...'.format(h_after))
            camera.release()
            camera = None
    print('ERROR: Cannot open camera at index {} or 1'.format(CAMERA_INDEX))
    return False

for attempt in range(3):
    if init_camera():
        break
    print('init_camera() failed (attempt {}/3). Retrying in 1s...'.format(attempt + 1))
    time.sleep(1)
else:
    print('FATAL: Camera could not be opened after 3 attempts.')
    print('Troubleshooting:')
    print('  1. Run: sudo usermod -aG video $USER  (then log out/in)')
    print('  2. Check: lsusb | grep -i eMeet')
    print('  3. Check: v4l2-ctl --list-devices')
    print('  4. Check: v4l2-ctl --device=/dev/video0 --list-formats-ext')
    print('  5. Check: sudo lsof /dev/video0 /dev/video1')
    print('  6. Try: sudo apt install -y v4l-utils')

# ---- Frame Helpers ----

def smooth_frame(frame):
    global _last_smooth_frame
    if not SMOOTH_ENABLED:
        _last_smooth_frame = frame
        return frame
    if _last_smooth_frame is None or _last_smooth_frame.shape != frame.shape:
        _last_smooth_frame = frame.astype(np.float32)
        return frame
    _last_smooth_frame = SMOOTH_ALPHA * _last_smooth_frame + (1.0 - SMOOTH_ALPHA) * frame.astype(np.float32)
    smoothed = cv2.convertScaleAbs(_last_smooth_frame)
    _last_smooth_frame = smoothed.astype(np.float32)
    return smoothed

def denoise_frame(frame, enable=True):
    if not enable:
        return frame
    try:
        h, w = frame.shape[:2]
        if max(h, w) > 3000:
            return frame
        if max(h, w) > 2000:
            return cv2.fastNlMeansDenoisingColored(frame, None, 3, 3, 7, 21)
        return cv2.fastNlMeansDenoisingColored(frame, None, 5, 5, 7, 21)
    except Exception:
        try:
            return cv2.bilateralFilter(frame, 5, 75, 75)
        except Exception:
            return frame

def sharpen_frame(frame):
    kernel = np.array([[0, -1, 0], [-1, 5, -1], [0, -1, 0]])
    return cv2.filter2D(frame, -1, kernel)

def read_frame():
    if camera is None or not camera.isOpened():
        return None
    with camera_lock:
        for _ in range(3):
            ok, frame = camera.read()
            if ok and frame is not None and frame.size > 0:
                if np.mean(frame) < 2.0:
                    continue
                return frame
            time.sleep(0.01)
    return None

def encode_jpeg(frame):
    params = [int(cv2.IMWRITE_JPEG_QUALITY), JPEG_QUALITY]
    try:
        params += [int(cv2.IMWRITE_JPEG_OPTIMIZE), 1]
        try:
            params += [int(cv2.IMWRITE_JPEG_PROGRESSIVE), 1]
        except Exception:
            pass
    except Exception:
        pass
    ok, buf = cv2.imencode('.jpg', frame, params)
    return buf.tobytes() if ok else None

# ---- Image Processing ----

def preprocess_image(frame, high_contrast=False):
    h, w = frame.shape[:2]
    processed = frame
    if max(h, w) > 2500:
        scale = 2500.0 / max(h, w)
        processed = cv2.resize(processed, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    processed = cv2.cvtColor(processed, cv2.COLOR_BGR2GRAY)
    if high_contrast:
        processed = cv2.convertScaleAbs(processed, alpha=1.5, beta=30)
        processed = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8)).apply(processed)
    else:
        processed = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(processed)
    processed = cv2.adaptiveThreshold(processed, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                      cv2.THRESH_BINARY, 11, 2)
    kernel = np.array([[0, -1, 0], [-1, 5, -1], [0, -1, 0]])
    processed = cv2.filter2D(processed, -1, kernel)
    return processed

def order_points(pts):
    pts = pts.reshape(4, 2)
    rect = np.zeros((4, 2), dtype=np.float32)
    s = pts.sum(axis=1)
    rect[0] = pts[np.argmin(s)]
    rect[2] = pts[np.argmax(s)]
    diff = np.diff(pts, axis=1)
    rect[1] = pts[np.argmin(diff)]
    rect[3] = pts[np.argmax(diff)]
    return rect

def detect_exam_sheet_corners(frame):
    h, w = frame.shape[:2]
    scale = 2000.0 / max(h, w)
    resized = cv2.resize(frame, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    gray = cv2.cvtColor(resized, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    edged = cv2.Canny(blurred, 50, 150)
    kernel = np.ones((3, 3), np.uint8)
    edged = cv2.dilate(edged, kernel, iterations=1)
    edged = cv2.erode(edged, kernel, iterations=1)
    contours, _ = cv2.findContours(edged, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None
    contours = sorted(contours, key=cv2.contourArea, reverse=True)
    for contour in contours:
        area = cv2.contourArea(contour)
        if area < (resized.shape[0] * resized.shape[1] * 0.2):
            continue
        peri = cv2.arcLength(contour, True)
        approx = cv2.approxPolyDP(contour, 0.02 * peri, True)
        if len(approx) == 4:
            pts = approx.reshape(4, 2) / scale
            return order_points(pts)
    return None

def four_point_warp(frame, pts):
    rect = order_points(pts)
    (tl, tr, br, bl) = rect
    width_a = np.linalg.norm(br - bl)
    width_b = np.linalg.norm(tr - tl)
    max_width = int(max(width_a, width_b))
    height_a = np.linalg.norm(tr - br)
    height_b = np.linalg.norm(tl - bl)
    max_height = int(max(height_a, height_b))
    dst = np.array([
        [0, 0], [max_width - 1, 0],
        [max_width - 1, max_height - 1], [0, max_height - 1]
    ], dtype=np.float32)
    matrix = cv2.getPerspectiveTransform(rect, dst)
    warped = cv2.warpPerspective(frame, matrix, (max_width, max_height))
    return warped

# ---- OCR ----

def run_tesseract(image, psm=3, config=None):
    if not TESSERACT_AVAILABLE:
        return ''
    try:
        img_bytes = cv2.imencode('.png', image)[1].tobytes()
        cmd = [TESSERACT_CMD, 'stdin', 'stdout', '--psm', str(psm), '-l', TESSERACT_LANG]
        if config:
            cmd.extend(['-c', config])
        result = subprocess.run(
            cmd, input=img_bytes, capture_output=True, timeout=30
        )
        if result.returncode == 0:
            return result.stdout.decode('utf-8', errors='replace')
    except Exception as e:
        print('Tesseract error:', e)
    return ''

def detect_sequence(gray_frame):
    h, w = gray_frame.shape[:2]
    bottom_h = max(80, int(h * 0.18))
    crop_top = h - bottom_h
    crop_left = int(w * 0.08)
    crop_right = int(w * 0.92)
    bottom_region = gray_frame[crop_top:h, crop_left:crop_right]
    bottom_region = cv2.resize(bottom_region, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)
    text = run_tesseract(bottom_region, psm=7, config='tessedit_char_whitelist=0123456789-DdMmYy-/ ')
    if not text:
        text = run_tesseract(bottom_region, psm=6)
    text = text.strip()
    patterns = [
        r'(\d{2}[-\/]\d{2}[-\/]\d{4})(?:[-\/](\d+))?',
        r'(\d{2}\s+\d{2}\s+\d{4})(?:\s+(\d+))?',
    ]
    for pattern in patterns:
        match = re.search(pattern, text)
        if match:
            date_part = match.group(1).replace(' ', '-').replace('/', '-')
            seq_num = match.group(2) if match.group(2) else None
            sequence = date_part + ('-' + seq_num if seq_num else '')
            confidence = 85 if len(date_part) >= 10 else 60
            return {
                'sequence': sequence,
                'confidence': confidence,
                'rawText': text,
                'cropRegion': {'top': crop_top, 'left': crop_left, 'width': crop_right - crop_left, 'height': bottom_h}
            }
    return {'sequence': None, 'confidence': 0, 'rawText': text, 'cropRegion': {'top': crop_top, 'left': crop_left, 'width': crop_right - crop_left, 'height': bottom_h}}

def detect_epoch(gray_frame):
    h, w = gray_frame.shape[:2]
    crop_w = max(40, int(w * 0.20))
    crop_h = max(20, int(h * 0.18))
    left = max(0, w - crop_w)
    top = 0
    top_right = gray_frame[top:crop_h, left:w]
    text = run_tesseract(top_right, psm=6)
    text = text.strip()
    patterns = [
        r'EPOCH[\s:\-]*([A-Z0-9\-]{5,25})',
        r'\bE[\s:\-]*(\d{4}[\-\s]?\d{2,3})\b',
        r'\bE\d{6,9}\b',
    ]
    epoch = None
    for pattern in patterns:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            epoch = re.sub(r'\s+', '-', match.group(1))
            break
    confidence = 85 if epoch else 0
    return {'epoch': epoch, 'confidence': confidence, 'rawText': text}

def detect_student_info(gray_frame):
    text = run_tesseract(gray_frame, psm=6)
    if not text:
        text = run_tesseract(gray_frame, psm=3)
    text = text.strip()
    student_number = ''
    student_name = ''
    lines = text.split('\n')
    number_patterns = [
        r'[Ss](?:tudent)?\s*(?:no|no\.|number|#|id)[\s:]*([A-Za-z]?\d{4}[-]?\d{3})',
        r'\b([A-Za-z]?\d{4}[-]?\d{3})\b',
    ]
    name_patterns = [
        r'(?:name|student|pupil)[\s:]*([A-Za-z\s\'\-]+?)(?:\n|$|,|;)',
        r'^(?:[A-Z][a-z]*(?:\s+[A-Z][a-z]*)+)\s*$',
    ]
    normalized = text.replace('I', '1').replace('O', '0').replace('l', '1').replace('S', '5')
    for line in lines:
        for pattern in number_patterns:
            match = re.search(pattern, line, re.IGNORECASE)
            if match and not student_number:
                student_number = match.group(1)
                break
    for line in lines:
        for pattern in name_patterns:
            match = re.search(pattern, line, re.IGNORECASE)
            if match and not student_name:
                candidate = match.group(1).strip()
                if len(candidate) > 2:
                    student_name = candidate
                break
    confidence = 0
    if student_number:
        confidence += 40
    if student_name and len(student_name) > 3:
        confidence += 30
    if student_number and student_name:
        confidence += 20
    confidence = min(confidence, 100)
    return {
        'studentNumber': student_number,
        'studentName': student_name,
        'rawText': text,
        'confidence': confidence
    }

# ---- Bubble Detection ----

def infer_grid_layout(num_questions, width, height):
    aspect_ratio = width / height if height > 0 else 1.3
    if num_questions <= 25:
        return 1, num_questions
    elif num_questions <= 50:
        if aspect_ratio > 1.6:
            return 2, 25
        elif aspect_ratio > 1.35:
            return 5, 10
        else:
            return 2, 25
    elif num_questions <= 75:
        return 3, 25
    elif num_questions <= 100:
        return 4, 25
    else:
        grid_rows = 25
        grid_cols = int(np.ceil(num_questions / grid_rows))
        return grid_cols, grid_rows

def detect_bubbles_vectorized(warped_gray, num_questions, answer_key=''):
    h, w = warped_gray.shape[:2]
    if h < 50 or w < 50:
        return ['' for _ in range(num_questions)], [0 for _ in range(num_questions)]
    grid_cols, grid_rows = infer_grid_layout(num_questions, w, h)
    top_margin = int(h * 0.05)
    bottom_margin = h - int(h * 0.05)
    left_margin = int(w * 0.05)
    right_margin = w - int(w * 0.05)
    usable_h = bottom_margin - top_margin
    usable_w = right_margin - left_margin
    cell_h = usable_h / grid_rows
    cell_w = usable_w / grid_cols
    bubble_radius = max(2, int(cell_h * 0.22))
    detected = []
    confidences = []
    for q in range(num_questions):
        col = q // grid_rows
        row = q % grid_rows
        cell_left = left_margin + col * cell_w
        cell_top = top_margin + row * cell_h
        cell_center_y = cell_top + cell_h / 2
        bubble_area_left = cell_left + cell_w * 0.18
        bubble_area_w = cell_w * 0.60
        intensities = []
        for c in range(4):
            cx = int(bubble_area_left + bubble_area_w * (c + 1) / 5)
            r = max(3, bubble_radius)
            y1 = max(0, int(cell_center_y) - r)
            y2 = min(h, int(cell_center_y) + r)
            x1 = max(0, cx - r)
            x2 = min(w, cx + r)
            roi = warped_gray[y1:y2, x1:x2]
            if roi.size == 0:
                intensities.append(255)
                continue
            mask = np.zeros(roi.shape, dtype=np.uint8)
            cy_roi = r
            cx_roi = r
            cv2.circle(mask, (cx_roi, cy_roi), r, 255, -1)
            masked_pixels = roi[mask > 0]
            if masked_pixels.size == 0:
                intensities.append(255)
                continue
            mean_val = float(np.mean(masked_pixels))
            dark_pct = float(np.sum(masked_pixels < 140)) / masked_pixels.size * 100
            very_dark_pct = float(np.sum(masked_pixels < 90)) / masked_pixels.size * 100
            intensities.append(mean_val)
        if len(intensities) < 4:
            detected.append('')
            confidences.append(0)
            continue
        ranked = sorted(enumerate(intensities), key=lambda x: x[1])
        darkest_idx, darkest_val = ranked[0]
        second_val = ranked[1][1]
        gap = second_val - darkest_val
        others = [v for _, v in ranked[1:]]
        avg_other = sum(others) / len(others)
        relative_gap = gap / max(1, avg_other)
        is_multi_mark = darkest_val < 220 and gap < 10 and second_val < 210
        answer = ''
        confidence = 0
        if not is_multi_mark:
            if relative_gap > 0.06 and (avg_other - darkest_val) > 4 and darkest_val < 215:
                answer = chr(65 + darkest_idx)
                confidence = min(98, 70 + int(relative_gap * 180) + int(max(0, avg_other - darkest_val) * 0.25))
            elif relative_gap > 0.045 and darkest_val < avg_other - 8:
                answer = chr(65 + darkest_idx)
                confidence = min(85, 55 + int(relative_gap * 160) + int(max(0, avg_other - darkest_val) * 0.2))
            elif darkest_val < avg_other - 8:
                answer = chr(65 + darkest_idx)
                confidence = min(70, 40 + int((220 - darkest_val) * 0.12))
        detected.append(answer)
        confidences.append(confidence)
    return detected, confidences

# ---- Full Scan Pipeline ----

def run_full_scan(base64_image, answer_key=''):
    try:
        image_data = base64.b64decode(base64_image)
        nparr = np.frombuffer(image_data, np.uint8)
        frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        if frame is None:
            return {'success': False, 'message': 'Failed to decode image'}
        original_h, original_w = frame.shape[:2]
        corners = detect_exam_sheet_corners(frame)
        if corners is not None:
            frame = four_point_warp(frame, corners)
        gray_for_brightness = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        avg_brightness = float(np.mean(gray_for_brightness))
        high_contrast = avg_brightness < 100
        processed = preprocess_image(frame, high_contrast=high_contrast)
        h, w = processed.shape[:2]
        gray_for_ocr = cv2.resize(processed, None, fx=1.5, fy=1.5, interpolation=cv2.INTER_CUBIC)
        gray_for_ocr = cv2.GaussianBlur(gray_for_ocr, (3, 3), 0)
        student_info = detect_student_info(gray_for_ocr)
        epoch_result = detect_epoch(gray_for_ocr)
        seq_result = detect_sequence(processed)
        num_questions = len(re.sub(r'\s+', '', answer_key)) if answer_key else 50
        detected_answers, confidences = detect_bubbles_vectorized(processed, num_questions, answer_key)
        avg_conf = 0
        if confidences:
            avg_conf = sum(confidences) / len(confidences)
        return {
            'success': True,
            'detectedAnswers': detected_answers,
            'confidenceScores': confidences,
            'averageConfidence': round(avg_conf, 2),
            'studentInfo': student_info,
            'epoch': epoch_result.get('epoch'),
            'epochConfidence': epoch_result.get('confidence', 0),
            'sequence': seq_result.get('sequence'),
            'sequenceConfidence': seq_result.get('confidence', 0),
            'rawOcrText': student_info.get('rawText', ''),
            'qualityMetrics': {
                'resolution': f'{original_w}x{original_h}',
                'warped': corners is not None,
                'numQuestions': num_questions
            }
        }
    except Exception as e:
        return {'success': False, 'message': str(e)}

# ---- Legacy Routes ----

@app.route('/stream')
def stream():
    if camera is None or not camera.isOpened():
        return Response('Camera not opened', status=503, mimetype='text/plain')
    def gen():
        global frame_count
        interval = 1.0 / STREAM_FPS
        last_yield_time = time.time()
        yielded = False
        while True:
            frame = read_frame()
            if frame is None:
                if not yielded:
                    print('STREAM WARNING: waiting for first frame...')
                time.sleep(interval)
                continue
            frame = denoise_frame(frame, enable=DENOISE_STREAM)
            frame = smooth_frame(frame)
            data = encode_jpeg(frame)
            if data is None:
                time.sleep(interval)
                continue
            frame_count += 1
            if not yielded:
                print('STREAM: first frame yielded')
                yielded = True
            yield (
                b'--frame\r\n'
                b'Content-Type: image/jpeg\r\n'
                b'Content-Length: ' + str(len(data)).encode() + b'\r\n\r\n'
                + data + b'\r\n'
            )
            now = time.time()
            elapsed = now - last_yield_time
            if elapsed < interval:
                time.sleep(interval - elapsed)
            last_yield_time = now
    return Response(gen(), mimetype='multipart/x-mixed-replace; boundary=frame')

@app.route('/capture')
def capture():
    global frame_count
    if camera is None or not camera.isOpened():
        return jsonify({'error': 'camera not opened'}), 503
    for _ in range(CAPTURE_WARMUP_FRAMES):
        read_frame()
        time.sleep(0.01)
    frame = read_frame()
    if frame is None:
        return jsonify({'error': 'camera read failed'}), 503
    frame = denoise_frame(frame, enable=DENOISE_CAPTURE)
    frame = sharpen_frame(frame)
    frame = smooth_frame(frame)
    data = encode_jpeg(frame)
    if data is None:
        return jsonify({'error': 'encode failed'}), 503
    frame_count += 1
    return Response(data, mimetype='image/jpeg')

@app.route('/detect-sequence')
def detect_sequence_legacy():
    if camera is None or not camera.isOpened():
        return jsonify({'error': 'camera not opened'}), 503
    frame = read_frame()
    if frame is None:
        return jsonify({'error': 'camera read failed'}), 503
    h, w = frame.shape[:2]
    bottom_h = max(80, int(h * 0.18))
    crop_top = h - bottom_h
    crop_left = int(w * 0.08)
    crop_right = int(w * 0.92)
    bottom_region = frame[crop_top:h, crop_left:crop_right]
    bottom_region = denoise_frame(bottom_region, enable=DENOISE_CAPTURE)
    bottom_region = sharpen_frame(bottom_region)
    ok, buf = cv2.imencode('.jpg', bottom_region, [int(cv2.IMWRITE_JPEG_QUALITY), JPEG_QUALITY])
    if not ok:
        return jsonify({'error': 'encode failed'}), 503
    jpg_bytes = buf.tobytes()
    b64 = base64.b64encode(jpg_bytes).decode('utf-8')
    return jsonify({
        'success': True,
        'image_base64': b64,
        'crop_region': {'top': crop_top, 'left': crop_left, 'width': crop_right - crop_left, 'height': bottom_h}
    })

@app.route('/scan', methods=['POST', 'OPTIONS'])
def scan():
    if request.method == 'OPTIONS':
        resp = jsonify({})
        resp.headers['Access-Control-Allow-Origin'] = '*'
        resp.headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS'
        resp.headers['Access-Control-Allow-Headers'] = 'Content-Type'
        return resp
    data = request.get_json(silent=True) or {}
    base64_image = data.get('imageBuffer') or data.get('image_base64')
    answer_key = data.get('answerKey', '')
    if not base64_image:
        return jsonify({'success': False, 'message': 'imageBuffer is required'}), 400
    result = run_full_scan(base64_image, answer_key)
    return jsonify(result)

@app.route('/test.jpg')
def test_jpg():
    if camera is None or not camera.isOpened():
        return Response('Camera not opened', status=503, mimetype='text/plain')
    frame = read_frame()
    if frame is None:
        return Response('No frame', status=503, mimetype='text/plain')
    frame = denoise_frame(frame, enable=DENOISE_CAPTURE)
    frame = sharpen_frame(frame)
    data = encode_jpeg(frame)
    if data is None:
        return Response('Encode failed', status=503, mimetype='text/plain')
    return Response(data, mimetype='image/jpeg')

@app.route('/status')
def status():
    cap_w = int(camera.get(cv2.CAP_PROP_FRAME_WIDTH)) if camera is not None and camera.isOpened() else 0
    cap_h = int(camera.get(cv2.CAP_PROP_FRAME_HEIGHT)) if camera is not None and camera.isOpened() else 0
    uptime = round(time.time() - start_time, 1)
    payload = {
        'camera_initialized': camera is not None and camera.isOpened(),
        'frame_count': frame_count,
        'uptime_seconds': uptime,
        'fps': STREAM_FPS,
        'resolution': '{}x{}'.format(cap_w, cap_h),
        'timestamp': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
    }
    if camera is None or not camera.isOpened():
        payload['hint'] = (
            'Camera failed to open. '
            'Try: sudo usermod -aG video $USER && reboot, '
            'or check lsusb / v4l2-ctl --list-devices'
        )
    return jsonify(payload)

@app.route('/')
def index():
    return send_from_directory('.', 'index.html')

@app.after_request
def add_cors(resp):
    resp.headers['Access-Control-Allow-Origin'] = '*'
    resp.headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
    resp.headers['Access-Control-Allow-Headers'] = 'Content-Type'
    return resp

if __name__ == '__main__':
    print('Camera server starting on http://0.0.0.0:{}'.format(PORT))
    print('Stream    : http://<pi-ip>:{}/stream'.format(PORT))
    print('Capture   : http://<pi-ip>:{}/capture'.format(PORT))
    print('Scan      : http://<pi-ip>:{}/scan  (POST imageBuffer)'.format(PORT))
    print('Test      : http://<pi-ip>:{}/test.jpg'.format(PORT))
    print('Status    : http://<pi-ip>:{}/status'.format(PORT))
    app.run(host=HOST, port=PORT, threaded=True)
