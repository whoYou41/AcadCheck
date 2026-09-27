"""Ensure faster pixel statistics preserve subpixel sampling and mark evidence."""
import unittest
import cv2
import numpy as np
import fast_omr_worker as omr


class FastStatisticsTest(unittest.TestCase):
    def test_histogram_percentiles_match_numpy(self):
        rng = np.random.default_rng(1216)
        for shape in ((1, 1), (11, 17), (500, 700)):
            source = rng.integers(0, 256, shape, dtype=np.uint8)
            for image in (source, source[:, ::2], np.full(shape, 203, np.uint8)):
                quantiles = [0, 5, 10, 33.3, 50, 75, 90, 95, 100]
                np.testing.assert_allclose(omr._uint8_percentiles(image, quantiles),
                                           np.percentile(image, quantiles), atol=1e-10)

    def test_large_histogram_does_not_round_float32_counts(self):
        # Above the exact float32 integer range, a one-pixel minority must not
        # disappear or move the 100th percentile out of the uint8 range.
        image = np.zeros((4097, 4096), np.uint8)
        image[-1, -1] = 255
        quantiles = [0, 50, 99.99999, 100]
        np.testing.assert_allclose(omr._uint8_percentiles(image, quantiles),
                                   np.percentile(image, quantiles), atol=1e-10)

    def test_batched_features_preserve_every_sample(self):
        rng = np.random.default_rng(1216)
        image = rng.integers(0, 256, (omr.CANONICAL_HEIGHT, omr.CANONICAL_WIDTH), dtype=np.uint8)
        left, top, right, bottom = omr.ANSWER_ROI
        adaptive = (image[top:bottom, left:right] > 128).astype(np.uint8) * 255
        centers = np.array([[[147 + (381 if row >= 25 else 0) + 38 * lane,
                              540 + 66 * (row % 25)] for lane in range(4)]
                            for row in range(50)], dtype=np.float32)
        centers += rng.uniform(-0.49, 0.49, centers.shape).astype(np.float32)
        expected = [np.zeros((50, 4), np.float32) for _ in range(4)]
        expected_patches = []
        for row in range(50):
            for lane in range(4):
                x, y = map(float, centers[row, lane])
                patch = cv2.getRectSubPix(image, (29, 29), (x, y))
                binary = cv2.getRectSubPix(adaptive, (29, 29), (x-left, y-top))
                inner = patch[omr._INNER_MASK]
                paper = float(np.percentile(patch[omr._CORNER_MASK], 75))
                expected[0][row, lane] = inner.mean()
                expected[1][row, lane] = paper
                expected[2][row, lane] = (binary[omr._INNER_MASK] > 0).mean()
                expected[3][row, lane] = (inner < max(25, paper-38)).mean()
                expected_patches.append(patch)
        actual = omr._extract_features(image, adaptive, centers)
        for reference, result in zip(expected, actual[:4]):
            np.testing.assert_array_equal(reference, result)
        np.testing.assert_array_equal(expected_patches, actual[4])


if __name__ == '__main__':
    unittest.main()
