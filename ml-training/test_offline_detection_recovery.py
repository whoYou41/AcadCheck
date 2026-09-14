"""Regression checks for tilted lanes and mixed-resolution live tracking."""
import json
import time
from unittest import mock
import cv2
import numpy as np
import fast_omr_worker as omr
from benchmark_fast_omr import _row_geometry_fixture, REAL_SCANS, TRUTHS

def main():
    centers, spacing, registration = _row_geometry_fixture()
    centers = np.asarray([[[147 + (381 if row >= 25 else 0) + 38 * lane,
                            540 + 66 * (row % 25)] for lane in range(4)]
                          for row in range(50)], dtype=np.float32)
    registration.update(templateRowStart=540.0, templateRowSpacing=66.0)
    cases = []
    for left_slope, right_slope in ((0, 0), (.018, -.022), (-.025, .03), (.03, .03)):
        truth = centers.copy()
        for block, slope in enumerate((left_slope, right_slope)):
            truth[block*25:(block+1)*25, :, 0] += slope * (truth[block*25:(block+1)*25, :, 1] - 1250)
        points = np.column_stack((truth.reshape(-1, 2), np.full(200, 13))).astype(np.float32)
        fitted, geometry = omr._fit_answer_grid(points, registration=registration)
        error = float(np.max(np.linalg.norm(fitted - truth, axis=2)))
        assert error < 1.0, (left_slope, right_slope, error)
        cases.append({'leftTilt': left_slope, 'rightTilt': right_slope, 'maxCenterError': round(error, 4)})
    # Missing edge rows and false lower rows must never move question identity.
    broken = centers.copy()
    broken[25:, :, 0] = broken[25:, :1, 0] + np.arange(4)[None, :] * 27
    points = np.column_stack((broken.reshape(-1, 2), np.full(200, 13))).astype(np.float32)
    try:
        omr._fit_answer_grid(points, registration=registration)
    except omr.OmrRejected:
        pass
    else:
        raise AssertionError('Actually inconsistent choice spacing was accepted')
    image = cv2.imread(str(REAL_SCANS / 'random.jpg'))
    tracked = []
    for frame_id, width in enumerate((1440, 1920, 1440), 1):
        frame = cv2.resize(image, (width, round(image.shape[0] * width / image.shape[1])), interpolation=cv2.INTER_AREA)
        _, encoded = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 92])
        started = time.perf_counter()
        result = omr.scan_image(encoded.tobytes(), {'useCnn': True, 'trackingSessionId': 'resolution-regression', 'frameId': frame_id})
        assert result.get('gradeable'), result.get('reason')
        assert ''.join(result['answers']) == TRUTHS['random.jpg'], result['answers']
        entry = omr._TRACKING_CACHE.get('resolution-regression')
        assert entry is not None
        tracked.append({'width': width, 'desktopMs': round((time.perf_counter()-started)*1000)})
        # Directly prove the transform is reusable at the other resolution.
        next_width = 1920 if width == 1440 else 1440
        gray = cv2.cvtColor(cv2.resize(image, (next_width, round(image.shape[0]*next_width/image.shape[1]))), cv2.COLOR_BGR2GRAY)
        candidate = omr._try_tracked_registration(gray, {'trackingSessionId': 'resolution-regression', 'frameId': frame_id + 1})
        assert candidate is not None, 'Resolution switch discarded tracking'
        warped, details = candidate
        assert details['locator'] == 'temporal-lk-usac'
        if frame_id == 1:
            omr._TRACKING_CACHE['cache-reuse-check'] = entry.copy()
            with mock.patch.object(omr.time, 'monotonic', return_value=entry['updatedAt'] + 0.01), \
                    mock.patch.object(omr.cv2, 'SIFT_create', side_effect=AssertionError('Redundant reference extraction')):
                omr._update_tracking_cache(gray, {'trackingSessionId': 'cache-reuse-check', 'frameId': 2}, details)
            reused = omr._TRACKING_CACHE['cache-reuse-check']
            assert reused['frameId'] == 2
            assert reused['referenceDescriptors'] is entry['referenceDescriptors']
            np.testing.assert_array_equal(reused['referenceSourceToCanonical'], entry['referenceSourceToCanonical'])
        references = omr._reference_frame_registration_candidates(gray, {'trackingSessionId': 'resolution-regression'})
        assert references, 'Resolution switch discarded reference recovery'
        reference_transform = np.asarray(references[0][1]['perspectiveTransform'])
        tracking_transform = np.asarray(details['perspectiveTransform'])
        source_points = cv2.perspectiveTransform(centers.reshape(-1, 1, 2), np.linalg.inv(tracking_transform))
        reference_centers = cv2.perspectiveTransform(source_points, reference_transform)
        assert np.max(np.linalg.norm(reference_centers - centers.reshape(-1, 1, 2), axis=2)) < 5
        assert omr._try_tracked_registration(gray, {'trackingSessionId': 'resolution-regression', 'frameId': frame_id}) is None
    print(json.dumps({'passed': True, 'tiltedLattices': cases, 'inconsistentSpacingRejected': True,
                      'referenceExtractionReused': True, 'mixedResolutionFrames': tracked}, indent=2))

if __name__ == '__main__':
    main()
