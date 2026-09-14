"""Small-sheet regression: header/footer circles must not shift question rows."""
import unittest
import cv2
import numpy as np
import fast_omr_worker as omr
from benchmark_fast_omr import REAL_SCANS, TRUTHS


class SmallSheetTest(unittest.TestCase):
    def test_small_photographs_keep_all_fifty_question_identities(self):
        cv2.setNumThreads(2)
        for name in ('random.jpg', 'allA.jpg', 'allB.jpg', 'allC.jpg', 'allD.jpg'):
            with self.subTest(photo=name):
                image = cv2.imread(str(REAL_SCANS / name))
                frame = cv2.resize(image, (1440, 810), interpolation=cv2.INTER_AREA)
                small = cv2.resize(frame, None, fx=.7, fy=.7, interpolation=cv2.INTER_AREA)
                canvas = np.full_like(frame, 65)
                x, y = (1440-small.shape[1])//2, (810-small.shape[0])//2
                canvas[y:y+small.shape[0], x:x+small.shape[1]] = small
                _, jpeg = cv2.imencode('.jpg', canvas, [cv2.IMWRITE_JPEG_QUALITY, 86])
                for frame_id in (1, 2):
                    result = omr.scan_image(jpeg.tobytes(), {
                        'useCnn': True, 'detectSequence': True,
                        'trackingSessionId': 'small-regression-' + name, 'frameId': frame_id,
                    })
                    self.assertTrue(result.get('gradeable'), result.get('reason'))
                    self.assertEqual(''.join(result['answers']), TRUTHS[name])
                    self.assertEqual(result['uncertainRows'], 0)
                    self.assertTrue(result['geometryVerified'])


if __name__ == '__main__':
    unittest.main()
