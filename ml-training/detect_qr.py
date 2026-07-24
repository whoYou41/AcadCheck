"""Decode an AcadCheck QR code from an image supplied by path or stdin."""
import argparse
import json
import struct
import sys

import cv2
import numpy as np


def _add_processed(candidates, gray):
    candidates.extend([
        gray,
        cv2.normalize(gray, None, 0, 255, cv2.NORM_MINMAX),
        cv2.createCLAHE(clipLimit=1.8, tileGridSize=(8, 8)).apply(gray),
        cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1],
    ])


def _canonical_bottom_candidates(gray):
    """Recover a small/soft QR from the known bottom area of this form."""
    try:
        # Reuse the exact page locator used by OMR so QR and bubbles share one
        # perspective contract. Importing this module does not load the CNN.
        from fast_omr_worker import _locate_and_warp

        warped, placement = _locate_and_warp(gray)
        if not placement.get('detected'):
            return []
    except Exception:
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
    if max(gray.shape) > 1800:
        # The generated QR is inside the page's reserved bottom cube. Enlarge
        # that canonical region before trying an expensive 4K decode.
        candidates = _canonical_bottom_candidates(gray)
        candidates.append(image)
        scale = 1800.0 / max(gray.shape)
        reduced = cv2.resize(
            gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA
        )
        _add_processed(candidates, reduced)
    else:
        candidates = [image]
        _add_processed(candidates, gray)
        candidates.extend(_canonical_bottom_candidates(gray))

    for candidate in candidates:
        payload, points = _decode_candidate(detector, candidate)
        if payload:
            return {
                'detected': True,
                'payload': payload.strip(),
                'corners': points.reshape(-1, 2).tolist() if points is not None else [],
                'reason': 'ok',
            }
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
