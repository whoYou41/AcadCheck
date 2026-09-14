"""Check APK grading JPEG profiles against photographed answer-sheet truth."""
import json
import time
import cv2
import numpy as np
from benchmark_fast_omr import REAL_SCANS, TRUTHS
import fast_omr_worker as omr


def main():
    cases = []
    for width, quality in ((1440, 86), (1920, 92)):
        for filename, truth in TRUTHS.items():
            frame = cv2.imread(str(REAL_SCANS / filename))
            assert frame is not None, filename
            if frame.shape[1] > width:
                frame = cv2.resize(frame, (width, round(frame.shape[0] * width / frame.shape[1])), interpolation=cv2.INTER_AREA)
            ok, encoded = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, quality])
            assert ok
            started = time.perf_counter()
            result = omr.scan_image(encoded.tobytes(), {'useCnn': True, 'detectSequence': True, 'includeOverlayGeometry': True})
            exact = sum(answer == expected for answer, expected in zip(result.get('answers', []), truth))
            cases.append({'photo': filename, 'width': width, 'quality': quality, 'bytes': len(encoded),
                          'correctRows': exact, 'gradeable': result.get('gradeable', False),
                          'desktopWallMs': round((time.perf_counter() - started) * 1000)})
            assert exact == 50 and result.get('gradeable') is True, json.dumps(cases[-1])
    blank = np.full((900, 1440, 3), 255, dtype=np.uint8)
    _, encoded = cv2.imencode('.jpg', blank)
    result = omr.scan_image(encoded.tobytes(), {'useCnn': True})
    assert not result.get('gradeable'), 'An empty camera image must not be graded'
    print(json.dumps({'passed': True, 'correctRows': 500, 'emptyFrameRejected': True, 'cases': cases}, indent=2))


if __name__ == '__main__':
    main()
