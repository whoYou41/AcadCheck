"""Current-frame tracking, cache safety and answer-change regressions."""
import json
import time
import unittest
from pathlib import Path
from unittest import mock
import cv2
import numpy as np
import fast_omr_worker as omr
from benchmark_fast_omr import REAL_SCANS, TRUTHS, encode, synthetic_state_cases, partial_document_variants


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

    def test_current_two_box_handwritten_01_is_read_as_student_one(self):
        page = np.full((omr.CANONICAL_HEIGHT, omr.CANONICAL_WIDTH), 255, np.uint8)
        left = round(omr.CANONICAL_WIDTH * 0.175 + 580 * 0.255)
        top, width, height = 2245, 118, 86
        cv2.rectangle(page, (left, top), (left + width, top + height), 0, 3)
        cv2.line(page, (left + width // 2, top), (left + width // 2, top + height), 0, 3)
        cv2.putText(page, '0', (left + 10, top + 64), cv2.FONT_HERSHEY_SIMPLEX, 1.45, 0, 3, cv2.LINE_AA)
        cv2.putText(page, '1', (left + 69, top + 64), cv2.FONT_HERSHEY_SIMPLEX, 1.45, 0, 3, cv2.LINE_AA)

        result = omr._detect_student_sequence(page)

        self.assertEqual(result['sequence'], '1')
        self.assertEqual(result['sequenceRawDigits'], '01')
        self.assertEqual(result['sequenceBoxCount'], 2)

    def test_shifted_wide_two_box_04_field_is_found_in_native_footer_fallback(self):
        page = np.full((omr.CANONICAL_HEIGHT, omr.CANONICAL_WIDTH), 255, np.uint8)
        # Model the photographed sheet where its centered footer field sits
        # farther right and is wider than the nominal registration profile.
        left = round(omr.CANONICAL_WIDTH * 0.175 + 580 * 0.34)
        top, width, height = 2245, 151, 86
        cv2.rectangle(page, (left, top), (left + width, top + height), 0, 3)
        cv2.line(page, (left + width // 2, top), (left + width // 2, top + height), 0, 3)
        cv2.putText(page, '0', (left + 15, top + 64), cv2.FONT_HERSHEY_SIMPLEX, 1.45, 0, 3, cv2.LINE_AA)
        cv2.putText(page, '4', (left + 94, top + 64), cv2.FONT_HERSHEY_SIMPLEX, 1.45, 0, 3, cv2.LINE_AA)

        result = omr._detect_student_sequence(page)

        self.assertEqual(result.get('sequence'), '4', result)
        self.assertEqual(result.get('sequenceRawDigits'), '04', result)
        self.assertEqual(result.get('sequenceBoxCount'), 2, result)

    def test_current_two_box_sequence_is_checked_before_legacy_layout(self):
        expected = {'sequence': '1', 'sequenceCandidate': '1', 'sequenceConfidence': 91}
        with mock.patch.object(omr, '_sequence_field_candidate', return_value={'left': 0, 'width': 10, 'top': 0, 'bottom': 10, 'height': 11}), \
             mock.patch.object(omr, '_classify_sequence_field', return_value=expected) as classify:
            result = omr._detect_student_sequence(np.full((2500, 800), 255, np.uint8))
        self.assertEqual(result['sequence'], '1')
        self.assertEqual(classify.call_args.args[2], 2)
        self.assertEqual(classify.call_count, 1)

    def test_changing_uncertain_row_counts_preserves_native_inference(self):
        patch = np.full((29, 29), 200, np.uint8)
        reference = None
        for count in (4, 8, 4, 12, 4, 16, 4, 200, 4, 16):
            probabilities = omr._cnn_probabilities([patch] * count)
            self.assertEqual(probabilities.shape, (count,))
            self.assertTrue(np.isfinite(probabilities).all())
            if reference is None:
                reference = float(probabilities[0])
            np.testing.assert_allclose(probabilities, reference, atol=1e-5)

    def test_original_camera_jpegs_keep_the_correct_answer_columns(self):
        for photo, truth in TRUTHS.items():
            with self.subTest(photo=photo):
                result = omr.scan_image((REAL_SCANS / photo).read_bytes(), {'useCnn': True})
                self.assertTrue(result.get('gradeable'), result.get('reason'))
                self.assertEqual(result['answers'], list(truth))

    def test_cropped_uniform_sheet_keeps_faint_answer_with_strong_independent_evidence(self):
        variants, _ = partial_document_variants(cv2.imread(str(REAL_SCANS / 'allC.jpg')))
        cropped = next(case for case in variants if case['name'] == 'cropped_top')
        result = omr.scan_image(encode(cropped['image']), {'useCnn': True})
        self.assertTrue(result['gradeable'])
        self.assertEqual(result['answers'], ['C'] * 50)

    def test_sequence_box_drift_tilt_lighting_and_negative_controls(self):
        crop = cv2.imread(str(REAL_SCANS.parents[1] / 'backend' / 'test-fixtures' / 'sequence-0003.png'), 0)
        page = np.full((2500, 800), 255, np.uint8)
        top, left = round(2500 * .865), round(800 * .175)
        page[top:top + crop.shape[0], left:left + crop.shape[1]] = crop
        for dx, dy, angle in ((0,0,0), (-12,0,0), (12,0,0), (-24,0,0), (24,0,0),
                              (0,-15,0), (0,15,0), (0,0,-1), (0,0,1)):
            transform = cv2.getRotationMatrix2D((400,2300), angle, 1)
            transform[:,2] += [dx,dy]
            shifted = cv2.warpAffine(page, transform, (800,2500), borderValue=255)
            for lighting in (1.0, .72):
                with self.subTest(dx=dx, dy=dy, angle=angle, lighting=lighting):
                    result = omr._detect_student_sequence(cv2.convertScaleAbs(shifted, alpha=lighting))
                    self.assertEqual(result.get('sequence'), '3', result)
                    self.assertGreaterEqual(result['sequenceConfidence'], 80)
        blank = np.full_like(page,255)
        text_only = blank.copy()
        cv2.putText(text_only, '0003', (400,2350), cv2.FONT_HERSHEY_SIMPLEX, 1, 0, 2)
        for negative in (blank, text_only):
            result = omr._detect_student_sequence(negative)
            self.assertFalse(result.get('sequence'))
            self.assertFalse(result.get('sequenceCandidate'))


if __name__ == '__main__':
    unittest.main()
