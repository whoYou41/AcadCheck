"""Current-frame tracking, cache safety and answer-change regressions."""
import json
import time
import unittest
from pathlib import Path
from unittest import mock
import cv2
import numpy as np
import fast_omr_worker as omr
from benchmark_fast_omr import REAL_SCANS, TRUTHS, encode, synthetic_state_cases


class LiveStabilityTest(unittest.TestCase):
    def setUp(self):
        cv2.setNumThreads(2)
        omr._TRACKING_CACHE.clear()

    def test_live_candidates_stay_correct_and_each_sheet_completes_promptly(self):
        fast_count = 0
        for photo in ('random.jpg', 'allC.jpg', 'allD.jpg'):
            source = cv2.imread(str(REAL_SCANS / photo))
            start = time.monotonic()
            complete_frames = []
            for index in range(16):
                width = 1440 if index < 4 else 1920
                height = round(source.shape[0] * width / source.shape[1])
                frame = cv2.resize(source, (width, height), interpolation=cv2.INTER_AREA)
                matrix = cv2.getRotationMatrix2D((width/2, height/2), (0,.2,-.2,.35)[index%4], 1)
                matrix[:, 2] += [(index%3)-1, (index%2)*.6]
                frame = cv2.warpAffine(frame, matrix, (width,height), borderValue=(40,40,40))
                frame = cv2.convertScaleAbs(frame, alpha=(1,.95,1.04,1)[index%4])
                if index%5 == 3:
                    frame = cv2.GaussianBlur(frame,(3,3),.55)
                with mock.patch.object(omr.time, 'monotonic', return_value=start+index*.65):
                    result = omr.scan_image(encode(frame, 86 if index<4 else 92), {
                        'useCnn': True, 'detectSequence': True,
                        'trackingSessionId': photo, 'frameId': index+1,
                    })
                with self.subTest(photo=photo, frame=index+1):
                    self.assertTrue(result.get('success'), result.get('reason'))
                    self.assertEqual([set(m) for m in result['markedLetters']], [{a} for a in TRUTHS[photo]])
                    if result.get('gradeable'):
                        self.assertEqual(''.join(result['answers']), TRUTHS[photo])
                        self.assertGreaterEqual(result['qualityMetrics']['overall'], 95.0)
                        self.assertIn('captureQuality', result['qualityMetrics'])
                        complete_frames.append(index)
                    else:
                        self.assertGreater(result['uncertainRows'], 0)
                fast_count += result.get('grid',{}).get('method') == 'tracked-current-ring-verification'
            # Completion must be available promptly, while isolated uncertain
            # later frames must abstain rather than force a confident answer.
            self.assertEqual(complete_frames[:2], [0, 1])
            self.assertGreaterEqual(len(complete_frames), 15)
        self.assertGreater(fast_count, 0, 'The validated fast path was never exercised')

    def test_bad_frame_does_not_replace_a_verified_tracking_reference(self):
        image = cv2.resize(cv2.imread(str(REAL_SCANS/'random.jpg')), (1440,810))
        jpeg = encode(image,92)
        self.assertTrue(omr.scan_image(jpeg, {'trackingSessionId':'cache','frameId':1})['gradeable'])
        reference = omr._TRACKING_CACHE['cache']
        classify = omr._classify_rows
        def uncertain(*args, **kwargs):
            result = classify(*args, **kwargs)
            result['uncertainRows'] = 1
            result['rowStates'][0] = 'uncertain'
            return result
        with mock.patch.object(omr, '_classify_rows', side_effect=uncertain):
            result = omr.scan_image(jpeg, {'trackingSessionId':'cache','frameId':2})
        self.assertFalse(result['gradeable'])
        self.assertIs(omr._TRACKING_CACHE['cache'], reference)
        # A clear frame after a bad one can use the original good reference.
        with mock.patch.object(omr.cv2, 'SIFT_create', side_effect=AssertionError('Timed reference rebuild')),                 mock.patch.object(omr.time, 'monotonic', return_value=reference['updatedAt']+3):
            result = omr.scan_image(jpeg, {'trackingSessionId':'cache','frameId':3})
        self.assertTrue(result['gradeable'])
        np.testing.assert_array_equal(omr._TRACKING_CACHE['cache']['anchorSmall'], reference['anchorSmall'])
        latest = omr._TRACKING_CACHE['cache']
        omr.scan_image(jpeg, {'trackingSessionId':'cache','frameId':1})
        self.assertIs(omr._TRACKING_CACHE['cache'], latest)

    def test_changed_marks_are_read_fresh_and_missing_rows_reject_fast_path(self):
        raw = cv2.imread(str(REAL_SCANS/'random.jpg'), cv2.IMREAD_GRAYSCALE)
        canonical, _ = omr._locate_and_warp(raw, allow_clipped=True)
        for name, changed, expected, should_grade in synthetic_state_cases():
            omr._TRACKING_CACHE.clear()
            first = omr.scan_image(encode(canonical,92), {'trackingSessionId':'marks','frameId':1})
            self.assertTrue(first['gradeable'])
            result = omr.scan_image(encode(changed,92), {'trackingSessionId':'marks','frameId':2})
            with self.subTest(case=name):
                self.assertEqual(result['gradeable'], should_grade)
                self.assertEqual([set(row) for row in result['markedLetters']], expected)
        entry = omr._TRACKING_CACHE['marks']
        centers, geometry, rings, ink = entry['verifiedGrid']
        gray = cv2.imdecode(np.frombuffer(encode(canonical,92),np.uint8),cv2.IMREAD_GRAYSCALE)
        warped = cv2.warpPerspective(gray, np.asarray(entry['sourceToCanonical']), (800,2500))
        for row in (0,24,25,49):
            masked = warped.copy()
            for x,y in centers[row]:
                cv2.rectangle(masked,(round(x)-23,round(y)-23),(round(x)+23,round(y)+23),255,-1)
            self.assertIsNone(omr._verify_tracked_grid(masked,entry['verifiedGrid'],omr.DEFAULT_GEOMETRY_TOLERANCES))
        stricter = dict(omr.DEFAULT_GEOMETRY_TOLERANCES, minimumGeometryConfidence=100)
        self.assertIsNone(omr._verify_tracked_grid(warped, entry['verifiedGrid'], stricter))
        shifted = centers.copy();shifted[:,:,1] += 33
        self.assertIsNone(omr._verify_tracked_grid(warped,(shifted,geometry,rings,ink),omr.DEFAULT_GEOMETRY_TOLERANCES))

    def test_partial_shading_and_known_sequence_capture_are_read(self):
        raw = cv2.imread(str(REAL_SCANS / 'random.jpg'), cv2.IMREAD_GRAYSCALE)
        canonical, _ = omr._locate_and_warp(raw, allow_clipped=True)
        circles, _, _ = omr._find_bubble_candidates(canonical)
        centers, _ = omr._fit_answer_grid(circles)
        truth = TRUTHS['random.jpg']
        changed = canonical.copy()
        for row in (2, 17):
            lane = omr.CHOICES.index(truth[row])
            donor = next(
                candidate
                for candidate, answer in enumerate(truth)
                if omr.CHOICES.index(answer) != lane
            )
            x, y = np.rint(centers[row, lane]).astype(int)
            source_x, source_y = np.rint(centers[donor, lane]).astype(int)
            changed[y - 14:y + 15, x - 14:x + 15] = canonical[
                source_y - 14:source_y + 15,
                source_x - 14:source_x + 15,
            ]
            cv2.ellipse(changed, (x, y), (10, 10), 0, -90, 90, 115, -1)
        result = omr.scan_image(encode(changed, 92), {'useCnn': True})
        self.assertTrue(result['gradeable'])
        self.assertEqual(''.join(result['answers']), truth)

        sequence_crop = cv2.imread(
            str(Path(__file__).resolve().parents[1] / 'backend' / 'test-fixtures' / 'sequence-0003.png'),
            cv2.IMREAD_GRAYSCALE,
        )
        sequence_page = np.full((omr.CANONICAL_HEIGHT, omr.CANONICAL_WIDTH), 255, np.uint8)
        top = round(omr.CANONICAL_HEIGHT * 0.865)
        left = round(omr.CANONICAL_WIDTH * 0.175)
        sequence_page[top:top + sequence_crop.shape[0], left:left + sequence_crop.shape[1]] = sequence_crop
        sequence = omr._detect_student_sequence(sequence_page)
        self.assertEqual(sequence['sequence'], '3')
        self.assertEqual(sequence['sequenceCandidate'], '3')
        self.assertEqual(sequence['sequenceRawDigits'], '0003')
        self.assertGreaterEqual(sequence['sequenceConfidence'], 90)


if __name__ == '__main__':
    unittest.main()
