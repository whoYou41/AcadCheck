"""Decode an AcadCheck QR code from an image supplied by path or stdin."""
import argparse
import json
from pathlib import Path
import struct
import sys

import cv2
import numpy as np

DIGIT_MODEL_PATH = (
    Path(__file__).resolve().parents[1]
    / "backend"
    / "models"
    / "digit-classifier.onnx"
)
_DIGIT_NET = None
_DIGIT_NET_LOAD_ATTEMPTED = False


def _add_processed(candidates, gray):
    candidates.extend([
        gray,
        cv2.normalize(gray, None, 0, 255, cv2.NORM_MINMAX),
        cv2.createCLAHE(clipLimit=1.8, tileGridSize=(8, 8)).apply(gray),
        cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1],
    ])


def _canonical_form(gray):
    try:
        # Reuse the exact page locator used by OMR so QR, sequence boxes, and
        # bubbles share one perspective-corrected coordinate system.
        from fast_omr_worker import _locate_and_warp

        warped, placement = _locate_and_warp(gray)
        if placement.get("detected"):
            return warped
    except Exception:
        pass
    return None


def _canonical_bottom_candidates(gray, warped=None):
    """Recover a small/soft QR from the known bottom area of this form."""
    warped = warped if warped is not None else _canonical_form(gray)
    if warped is None:
        return []

    height, width = warped.shape
    regions = [
        warped[int(height * 0.62):height, :],
        warped[int(height * 0.72):height, :],
    ]
    candidates = [warped]
    for region in regions:
        # Upscaling the bounded bottom ROI is much cheaper and more effective
        # than enlarging the entire camera frame.
        for scale in (2.0, 3.0):
            enlarged = cv2.resize(
                region, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC
            )
            blurred = cv2.GaussianBlur(enlarged, (0, 0), 1.0)
            sharpened = cv2.addWeighted(enlarged, 1.8, blurred, -0.8, 0)
            _add_processed(candidates, sharpened)
            block_size = max(31, (int(min(sharpened.shape) * 0.08) | 1))
            candidates.append(
                cv2.adaptiveThreshold(
                    sharpened,
                    255,
                    cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                    cv2.THRESH_BINARY,
                    block_size,
                    5,
                )
            )
    return candidates


def _load_digit_net():
    global _DIGIT_NET, _DIGIT_NET_LOAD_ATTEMPTED
    if _DIGIT_NET_LOAD_ATTEMPTED:
        return _DIGIT_NET
    _DIGIT_NET_LOAD_ATTEMPTED = True
    try:
        if DIGIT_MODEL_PATH.exists():
            _DIGIT_NET = cv2.dnn.readNetFromONNX(str(DIGIT_MODEL_PATH))
    except Exception:
        _DIGIT_NET = None
    return _DIGIT_NET


def _softmax(values):
    values = np.asarray(values, dtype=np.float32).reshape(-1)
    shifted = values - float(np.max(values))
    exponentials = np.exp(shifted)
    return exponentials / max(1e-9, float(np.sum(exponentials)))


def _classify_digit_cell(cell):
    """Classify one handwritten digit after removing the printed box."""
    if cell is None or min(cell.shape[:2]) < 8:
        return None
    height, width = cell.shape[:2]
    margin_x = max(2, int(round(width * 0.16)))
    margin_y = max(2, int(round(height * 0.16)))
    interior = cell[margin_y:height - margin_y, margin_x:width - margin_x]
    if interior.size == 0:
        return None

    background = float(np.percentile(interior, 90))
    raw_ink_pixels = int(np.count_nonzero(interior < max(20.0, background - 24.0)))
    if raw_ink_pixels < max(5, int(round(interior.size * 0.012))):
        return None

    normalized = cv2.normalize(interior, None, 0, 255, cv2.NORM_MINMAX)
    ink = cv2.threshold(
        normalized, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU
    )[1]
    component_count, labels, stats, _ = cv2.connectedComponentsWithStats(ink, 8)
    cleaned = np.zeros_like(ink)
    minimum_component_area = max(3, int(round(ink.size * 0.006)))
    for label in range(1, component_count):
        if stats[label, cv2.CC_STAT_AREA] >= minimum_component_area:
            cleaned[labels == label] = 255
    ink_pixels = int(cv2.countNonZero(cleaned))
    if (
        ink_pixels < max(5, int(round(cleaned.size * 0.012)))
        or ink_pixels > int(round(cleaned.size * 0.62))
    ):
        return None

    points = cv2.findNonZero(cleaned)
    x, y, box_width, box_height = cv2.boundingRect(points)
    digit = normalized[y:y + box_height, x:x + box_width]
    side = max(box_width, box_height)
    padding = max(3, int(round(side * 0.20)))
    canvas_side = side + padding * 2
    canvas = np.full((canvas_side, canvas_side), 255, dtype=np.uint8)
    target_x = (canvas_side - box_width) // 2
    target_y = (canvas_side - box_height) // 2
    canvas[target_y:target_y + box_height, target_x:target_x + box_width] = digit
    model_input = cv2.resize(canvas, (32, 32), interpolation=cv2.INTER_AREA)

    net = _load_digit_net()
    if net is None:
        return None
    net.setInput(model_input.astype(np.float32)[None, None, :, :] / 255.0)
    logits = net.forward().reshape(-1)
    probabilities = _softmax(logits)
    predicted = int(np.argmax(probabilities))
    confidence = float(probabilities[predicted])
    second = float(np.partition(probabilities, -2)[-2])
    if confidence < 0.24 or confidence - second < 0.015:
        return None
    return {
        "digit": predicted,
        "confidence": confidence,
    }


def _select_sequence_boxes(binary, qr_width):
    contours, _ = cv2.findContours(binary, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    candidates = []
    for contour in contours:
        x, y, width, height = cv2.boundingRect(contour)
        if not (qr_width * 0.20 <= width <= qr_width * 0.72):
            continue
        if not (qr_width * 0.28 <= height <= qr_width * 0.78):
            continue
        aspect = width / max(1.0, float(height))
        if not 0.50 <= aspect <= 1.35:
            continue
        contour_area = float(cv2.contourArea(contour))
        rectangularity = contour_area / max(1.0, float(width * height))
        if rectangularity < 0.55:
            continue
        candidates.append((x, y, width, height))

    # RETR_LIST exposes both sides of a printed border. Collapse concentric
    # rectangles so each physical writing box contributes one candidate.
    candidates.sort(key=lambda box: box[2] * box[3], reverse=True)
    deduplicated = []
    for candidate in candidates:
        x, y, width, height = candidate
        center_x = x + width / 2
        center_y = y + height / 2
        if any(
            abs(center_x - (other_x + other_width / 2)) < min(width, other_width) * 0.25
            and abs(center_y - (other_y + other_height / 2)) < min(height, other_height) * 0.25
            for other_x, other_y, other_width, other_height in deduplicated
        ):
            continue
        deduplicated.append(candidate)

    candidates = sorted(deduplicated, key=lambda box: (box[0], box[1]))
    best = None
    for start in range(max(0, len(candidates) - 3)):
        group = candidates[start:start + 4]
        if len(group) != 4:
            continue
        centers_y = np.asarray([y + height / 2 for _, y, _, height in group])
        heights = np.asarray([height for _, _, _, height in group])
        widths = np.asarray([width for _, _, width, _ in group])
        gaps = np.asarray([
            group[index + 1][0] - (group[index][0] + group[index][2])
            for index in range(3)
        ])
        if np.any(gaps < -qr_width * 0.08) or np.any(gaps > qr_width * 0.38):
            continue
        score = (
            float(np.std(centers_y))
            + float(np.std(heights))
            + float(np.std(widths))
            + float(np.std(gaps))
        )
        if best is None or score < best[0]:
            best = (score, group)
    return best[1] if best is not None else []


def _detect_handwritten_sequence(warped):
    if warped is None:
        return {
            "sequence": None,
            "sequenceConfidence": 0,
            "sequenceReason": "canonical page unavailable",
        }
    detector = cv2.QRCodeDetector()
    _, points, _ = detector.detectAndDecode(warped)
    if points is None:
        detected, points = detector.detect(warped)
        if not detected:
            points = None
    if points is None:
        return {
            "sequence": None,
            "sequenceConfidence": 0,
            "sequenceReason": "QR anchor unavailable in canonical page",
        }

    qr = np.asarray(points, dtype=np.float32).reshape(4, 2)
    qr_left = float(np.min(qr[:, 0]))
    qr_right = float(np.max(qr[:, 0]))
    qr_top = float(np.min(qr[:, 1]))
    qr_bottom = float(np.max(qr[:, 1]))
    qr_width = max(20.0, qr_right - qr_left)
    image_height, image_width = warped.shape[:2]

    left = max(0, int(round(qr_right + qr_width * 0.05)))
    right = min(image_width, int(round(qr_right + qr_width * 3.15)))
    top = max(0, int(round(qr_top - qr_width * 0.10)))
    bottom = min(image_height, int(round(qr_bottom + qr_width * 0.18)))
    if right - left < qr_width or bottom - top < qr_width * 0.5:
        return {
            "sequence": None,
            "sequenceConfidence": 0,
            "sequenceReason": "sequence region is outside the visible page",
        }

    region = warped[top:bottom, left:right]
    normalized = cv2.normalize(region, None, 0, 255, cv2.NORM_MINMAX)
    binary = cv2.threshold(
        normalized, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU
    )[1]
    boxes = _select_sequence_boxes(binary, qr_width)
    if len(boxes) != 4:
        return {
            "sequence": None,
            "sequenceConfidence": 0,
            "sequenceReason": f"expected four sequence boxes; found {len(boxes)}",
        }

    digits = []
    confidences = []
    for x, y, width, height in boxes:
        result = _classify_digit_cell(region[y:y + height, x:x + width])
        if result is None:
            continue
        digits.append(str(result["digit"]))
        confidences.append(float(result["confidence"]))
    if not digits:
        return {
            "sequence": None,
            "sequenceConfidence": 0,
            "sequenceReason": "sequence boxes are blank or ambiguous",
        }

    value = int("".join(digits))
    if value <= 0:
        return {
            "sequence": None,
            "sequenceConfidence": 0,
            "sequenceReason": "student sequence number must be greater than zero",
        }
    confidence = 100.0 * float(np.mean(confidences))
    return {
        "sequence": str(value),
        "sequenceConfidence": round(confidence, 2),
        "sequenceDigitsRead": len(digits),
        "sequenceBoxes": [
            [left + x, top + y, width, height] for x, y, width, height in boxes
        ],
        "sequenceReason": "ok",
    }


def _decode_candidate(detector, candidate):
    payload, points, _ = detector.detectAndDecode(candidate)
    if payload:
        return payload, points

    # OpenCV can locate a small/soft QR while failing to sample its modules.
    # Re-warp that detected square at a larger scale and retry with a quiet
    # border before falling through to more expensive whole-page variants.
    try:
        detected, located = detector.detect(candidate)
    except Exception:
        return '', None
    if not detected or located is None:
        return '', None
    quad = np.asarray(located, dtype=np.float32).reshape(4, 2)
    center = np.mean(quad, axis=0)
    quad = center + (quad - center) * 1.12
    side = int(
        np.clip(
            max(
                np.linalg.norm(quad[1] - quad[0]),
                np.linalg.norm(quad[2] - quad[1]),
            )
            * 3.0,
            240,
            900,
        )
    )
    destination = np.asarray(
        [[0, 0], [side - 1, 0], [side - 1, side - 1], [0, side - 1]],
        dtype=np.float32,
    )
    matrix = cv2.getPerspectiveTransform(quad, destination)
    recovered = cv2.warpPerspective(
        candidate,
        matrix,
        (side, side),
        flags=cv2.INTER_CUBIC,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=255,
    )
    border = max(20, side // 12)
    recovered = cv2.copyMakeBorder(
        recovered,
        border,
        border,
        border,
        border,
        cv2.BORDER_CONSTANT,
        value=255,
    )
    recovered_gray = (
        cv2.cvtColor(recovered, cv2.COLOR_BGR2GRAY)
        if len(recovered.shape) == 3
        else recovered
    )
    recovery_candidates = [
        recovered,
        cv2.normalize(recovered_gray, None, 0, 255, cv2.NORM_MINMAX),
        cv2.threshold(
            recovered_gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU
        )[1],
    ]
    for recovery in recovery_candidates:
        recovered_payload, _, _ = cv2.QRCodeDetector().detectAndDecode(recovery)
        if recovered_payload:
            return recovered_payload, located
    return '', located


def decode(image):
    if image is None:
        return {'detected': False, 'payload': None, 'reason': 'image unreadable'}

    detector = cv2.QRCodeDetector()
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if len(image.shape) == 3 else image

    # On the generated form the QR is deliberately in the reserved cube near
    # the bottom. Try that small raw ROI first: it avoids a full-page warp and
    # normally resolves the key in a fraction of the fallback time.
    image_height, _ = gray.shape
    quick_candidates = [gray[int(round(image_height * 0.50)):image_height, :]]
    _add_processed(quick_candidates, quick_candidates[0])
    for candidate in quick_candidates:
        payload, points = _decode_candidate(detector, candidate)
        if payload:
            result = {
                'detected': True,
                'payload': payload.strip(),
                'corners': points.reshape(-1, 2).tolist() if points is not None else [],
                'reason': 'ok',
            }
            result.update(_detect_handwritten_sequence(gray))
            return result

    canonical = _canonical_form(gray)
    if max(gray.shape) > 1800:
        # The generated QR is inside the page's reserved bottom cube. Enlarge
        # that canonical region before trying an expensive 4K decode.
        candidates = _canonical_bottom_candidates(gray, canonical)
        candidates.append(image)
        scale = 1800.0 / max(gray.shape)
        reduced = cv2.resize(
            gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA
        )
        _add_processed(candidates, reduced)
    else:
        candidates = [image]
        _add_processed(candidates, gray)
        candidates.extend(_canonical_bottom_candidates(gray, canonical))

    for candidate in candidates:
        payload, points = _decode_candidate(detector, candidate)
        if payload:
            result = {
                'detected': True,
                'payload': payload.strip(),
                'corners': points.reshape(-1, 2).tolist() if points is not None else [],
                'reason': 'ok',
            }
            # Read the boxes beside the QR in the untouched frame first. This
            # preserves their square geometry on the narrow cut-out form; the
            # canonical page warp remains a fallback for stronger perspective.
            sequence_result = _detect_handwritten_sequence(gray)
            if not sequence_result.get("sequence") and canonical is not None:
                canonical_result = _detect_handwritten_sequence(canonical)
                if canonical_result.get("sequence"):
                    sequence_result = canonical_result
            result.update(sequence_result)
            return result
    return {'detected': False, 'payload': None, 'reason': 'No readable QR code found'}


def _read_exact(stream, length):
    chunks = bytearray()
    while len(chunks) < length:
        chunk = stream.read(length - len(chunks))
        if not chunk:
            return None
        chunks.extend(chunk)
    return bytes(chunks)


def _read_u32(stream):
    value = _read_exact(stream, 4)
    return struct.unpack('>I', value)[0] if value is not None else None


def _write_response(stream, payload):
    encoded = json.dumps(payload, separators=(',', ':')).encode('utf-8')
    stream.write(struct.pack('>I', len(encoded)))
    stream.write(encoded)
    stream.flush()


def worker_loop():
    input_stream = sys.stdin.buffer
    output_stream = sys.stdout.buffer
    while True:
        header_length = _read_u32(input_stream)
        if header_length is None:
            return 0
        if header_length <= 0 or header_length > 1024 * 1024:
            return 2
        header_bytes = _read_exact(input_stream, header_length)
        image_length = _read_u32(input_stream)
        if header_bytes is None or image_length is None:
            return 2
        if image_length <= 0 or image_length > 60 * 1024 * 1024:
            return 2
        image_bytes = _read_exact(input_stream, image_length)
        if image_bytes is None:
            return 2
        try:
            header = json.loads(header_bytes.decode('utf-8'))
            encoded = np.frombuffer(image_bytes, dtype=np.uint8)
            result = decode(cv2.imdecode(encoded, cv2.IMREAD_COLOR))
            result['id'] = header.get('id')
        except Exception as error:
            result = {
                'id': None,
                'detected': False,
                'payload': None,
                'reason': f'QR detector failed: {error}',
            }
        _write_response(output_stream, result)


def main():
    parser = argparse.ArgumentParser(description='Decode an AcadCheck QR code')
    parser.add_argument('image', nargs='?', help='Image path, or - for stdin')
    parser.add_argument('--worker', action='store_true', help='Run persistent binary worker')
    args = parser.parse_args()
    if args.worker:
        return worker_loop()
    if not args.image:
        parser.error('image is required unless --worker is used')
    if args.image == '-':
        data = np.frombuffer(sys.stdin.buffer.read(), dtype=np.uint8)
        image = cv2.imdecode(data, cv2.IMREAD_COLOR)
    else:
        image = cv2.imread(args.image, cv2.IMREAD_COLOR)
    print(json.dumps(decode(image)))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
