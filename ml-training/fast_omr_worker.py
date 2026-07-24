#!/usr/bin/env python3
"""
Fast, fail-closed OMR reader for the AcadCheck 50-question / four-choice form.

The worker owns the complete vision hot path:

* decode once to grayscale;
* find the current sheet at low resolution and perspective-warp it once;
* locate the two 25-row answer grids from printed bubble rings;
* classify all 200 cells with local and row-relative OpenCV features;
* run the bubble CNN in one batch only for genuinely uncertain rows.

Worker protocol (all lengths are unsigned big-endian uint32 values):

    request:  header_length, UTF-8 JSON header, image_length, encoded image
    response: response_length, UTF-8 JSON response

The binary protocol avoids base64 expansion and keeps OpenCV/ONNX loaded between
camera frames.  The module also has a one-shot CLI for benchmarks and diagnosis.
"""

from __future__ import annotations

import argparse
import json
import math
import struct
import sys
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

import cv2
import numpy as np

CANONICAL_WIDTH = 800
CANONICAL_HEIGHT = 1400
ANSWER_ROI = (40, 230, 740, 1250)
CHOICES = "ABCD"
FORM_LAYOUT = "acadcheck-50-v1"
MODEL_PATH = Path(__file__).resolve().parents[1] / "backend" / "models" / "bubble-classifier.onnx"

_INNER_Y, _INNER_X = np.ogrid[-14:15, -14:15]
_INNER_MASK = (_INNER_X * _INNER_X + _INNER_Y * _INNER_Y) <= 8 * 8
_CORNER_MASK = (np.abs(_INNER_X) >= 10) & (np.abs(_INNER_Y) >= 10)
_PROFILE_COORD_CACHE: Dict[int, np.ndarray] = {}
_CNN_NET = None
_CNN_LOAD_ATTEMPTED = False


class OmrRejected(RuntimeError):
    """A readable image that cannot be graded without guessing."""

    def __init__(self, reason: str, details: Optional[Dict[str, Any]] = None):
        super().__init__(reason)
        self.reason = reason
        self.details = details or {}


def _stage_ms(start: float) -> float:
    return round((time.perf_counter() - start) * 1000.0, 3)


def _order_quad(points: np.ndarray) -> np.ndarray:
    points = np.asarray(points, dtype=np.float32).reshape(4, 2)
    sums = points.sum(axis=1)
    diffs = np.diff(points, axis=1).reshape(-1)
    return np.asarray(
        [
            points[np.argmin(sums)],
            points[np.argmin(diffs)],
            points[np.argmax(sums)],
            points[np.argmax(diffs)],
        ],
        dtype=np.float32,
    )


def _quad_dimensions(quad: np.ndarray) -> Tuple[float, float]:
    tl, tr, br, bl = quad
    width = 0.5 * (np.linalg.norm(tr - tl) + np.linalg.norm(br - bl))
    height = 0.5 * (np.linalg.norm(bl - tl) + np.linalg.norm(br - tr))
    return float(width), float(height)


def _page_candidates(mask: np.ndarray) -> List[Tuple[float, np.ndarray]]:
    height, width = mask.shape
    frame_area = float(height * width)
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    candidates: List[Tuple[float, np.ndarray]] = []
    for contour in contours:
        area = float(cv2.contourArea(contour))
        if area < frame_area * 0.08:
            continue
        perimeter = float(cv2.arcLength(contour, True))
        if perimeter <= 0:
            continue
        quad = None
        for epsilon in (0.012, 0.018, 0.025, 0.035):
            approximation = cv2.approxPolyDP(contour, epsilon * perimeter, True)
            if len(approximation) == 4 and cv2.isContourConvex(approximation):
                quad = approximation.reshape(4, 2)
                break
        if quad is None:
            continue
        ordered = _order_quad(quad)
        paper_width, paper_height = _quad_dimensions(ordered)
        if min(paper_width, paper_height) < 120:
            continue
        aspect = min(paper_width, paper_height) / max(paper_width, paper_height)
        if aspect < 0.28 or aspect > 0.90:
            continue
        rectangularity = area / max(1.0, paper_width * paper_height)
        if rectangularity < 0.68:
            continue
        candidates.append((area * min(1.0, rectangularity), ordered))
    return candidates


def _locate_and_warp(gray: np.ndarray) -> Tuple[np.ndarray, Dict[str, Any]]:
    """Locate a bright portrait answer sheet and warp it to canonical space."""

    image_height, image_width = gray.shape
    scale = min(1.0, 900.0 / max(image_height, image_width))
    if scale < 1.0:
        small = cv2.resize(gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    else:
        small = gray

    blurred = cv2.GaussianBlur(small, (5, 5), 0)
    otsu_value, paper_mask = cv2.threshold(
        blurred, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU
    )
    close_size = max(9, int(round(min(small.shape) * 0.014)) | 1)
    paper_mask = cv2.morphologyEx(
        paper_mask,
        cv2.MORPH_CLOSE,
        np.ones((close_size, close_size), dtype=np.uint8),
        iterations=1,
    )
    candidates = _page_candidates(paper_mask)

    # Edge geometry is a bounded fallback for pale paper under a bright wall.
    # It runs only when the cheap Otsu paper mask did not establish a quad.
    locator = "otsu-paper-contour"
    if not candidates:
        edges = cv2.Canny(blurred, 45, 135)
        edges = cv2.morphologyEx(
            edges,
            cv2.MORPH_CLOSE,
            np.ones((9, 9), dtype=np.uint8),
            iterations=2,
        )
        candidates = _page_candidates(edges)
        locator = "canny-paper-contour"

    if not candidates:
        raise OmrRejected("Answer sheet boundary not found")

    _, quad_small = max(candidates, key=lambda item: item[0])
    quad = quad_small / scale
    paper_width, paper_height = _quad_dimensions(quad)

    # A sideways form is rotated before a second, bounded localization pass.
    # The public result remains in canonical form coordinates, so original
    # corner coordinates are not consumed by the grading code.
    if paper_width > paper_height * 1.08:
        rotated = cv2.rotate(gray, cv2.ROTATE_90_CLOCKWISE)
        warped, placement = _locate_and_warp(rotated)
        placement["sourceOrientation"] = "sideways"
        return warped, placement

    coverage = float(cv2.contourArea(quad.astype(np.float32))) / max(
        1.0, float(image_width * image_height)
    )
    aspect_ratio = paper_width / max(1.0, paper_height)
    if not (0.30 <= aspect_ratio <= 0.90):
        raise OmrRejected(
            "Detected page does not match the AcadCheck portrait form",
            {"pageAspectRatio": round(aspect_ratio, 4), "pageCoverage": round(coverage, 4)},
        )

    destination = np.asarray(
        [
            [0, 0],
            [CANONICAL_WIDTH - 1, 0],
            [CANONICAL_WIDTH - 1, CANONICAL_HEIGHT - 1],
            [0, CANONICAL_HEIGHT - 1],
        ],
        dtype=np.float32,
    )
    transform = cv2.getPerspectiveTransform(quad.astype(np.float32), destination)
    warped = cv2.warpPerspective(
        gray,
        transform,
        (CANONICAL_WIDTH, CANONICAL_HEIGHT),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=255,
    )

    top_angle = math.degrees(math.atan2(quad[1, 1] - quad[0, 1], quad[1, 0] - quad[0, 0]))
    page_confidence = 100.0
    if coverage < 0.12:
        page_confidence -= 30.0
    elif coverage < 0.20:
        page_confidence -= 12.0
    if coverage > 0.99:
        page_confidence -= 8.0
    if not (0.38 <= aspect_ratio <= 0.70):
        page_confidence -= 10.0
    return warped, {
        "detected": True,
        "acceptable": page_confidence >= 65,
        "confidence": round(max(0.0, page_confidence), 2),
        "coverage": round(coverage, 4),
        "aspectRatio": round(aspect_ratio, 4),
        "rotationDeg": round(top_angle, 2),
        "locator": locator,
        "otsuThreshold": round(float(otsu_value), 2),
        "canonicalSize": [CANONICAL_WIDTH, CANONICAL_HEIGHT],
    }


def _deduplicate_circles(circles: Iterable[Sequence[float]], distance: float = 4.0) -> np.ndarray:
    ordered = sorted(circles, key=lambda item: float(item[2]), reverse=True)
    kept: List[Tuple[float, float, float]] = []
    distance_squared = distance * distance
    for x, y, radius in ordered:
        if all((x - kx) ** 2 + (y - ky) ** 2 > distance_squared for kx, ky, _ in kept):
            kept.append((float(x), float(y), float(radius)))
    if not kept:
        return np.empty((0, 3), dtype=np.float32)
    return np.asarray(kept, dtype=np.float32)


def _contour_circle_candidates(binary_roi: np.ndarray, offset_x: int, offset_y: int) -> List[Tuple[float, float, float]]:
    contours, _ = cv2.findContours(binary_roi, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    candidates: List[Tuple[float, float, float]] = []
    for contour in contours:
        area = float(cv2.contourArea(contour))
        if area < 90 or area > 1050:
            continue
        x, y, width, height = cv2.boundingRect(contour)
        if width < 13 or height < 13 or width > 38 or height > 38:
            continue
        aspect = width / max(1.0, float(height))
        if aspect < 0.72 or aspect > 1.38:
            continue
        perimeter = float(cv2.arcLength(contour, True))
        circularity = 4.0 * math.pi * area / max(1.0, perimeter * perimeter)
        if circularity < 0.42:
            continue
        radius = 0.25 * (width + height)
        candidates.append((offset_x + x + width / 2.0, offset_y + y + height / 2.0, radius))
    return candidates


def _find_bubble_candidates(warped: np.ndarray) -> Tuple[np.ndarray, np.ndarray, Dict[str, Any]]:
    left, top, right, bottom = ANSWER_ROI
    roi = warped[top:bottom, left:right]
    p10, p90 = np.percentile(roi, [10, 90])
    local_range = float(p90 - p10)
    clahe_used = local_range < 82.0
    locator_roi = roi
    if clahe_used:
        locator_roi = cv2.createCLAHE(clipLimit=1.6, tileGridSize=(8, 8)).apply(roi)

    smooth = cv2.GaussianBlur(locator_roi, (3, 3), 0)
    hough = cv2.HoughCircles(
        smooth,
        cv2.HOUGH_GRADIENT,
        dp=1.1,
        minDist=9,
        param1=90,
        param2=16,
        minRadius=6,
        maxRadius=15,
    )
    candidates: List[Tuple[float, float, float]] = []
    hough_count = 0
    if hough is not None:
        for x, y, radius in hough[0]:
            candidates.append((left + float(x), top + float(y), float(radius)))
        hough_count = len(hough[0])

    adaptive = cv2.adaptiveThreshold(
        locator_roi,
        255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY_INV,
        31,
        8,
    )
    adaptive = cv2.morphologyEx(
        adaptive, cv2.MORPH_OPEN, np.ones((2, 2), dtype=np.uint8), iterations=1
    )

    circles = _deduplicate_circles(candidates)
    radius_reference = float(np.percentile(circles[:, 2], 65)) if len(circles) else 0.0
    radius_floor = max(8.8, min(11.3, radius_reference * 0.76))
    bubble_sized = circles[circles[:, 2] >= radius_floor] if len(circles) else circles

    # Contours supplement (not replace) Hough evidence only when the Hough
    # population is incomplete.  Avoiding a second full candidate merge on a
    # clean sheet saves substantial live-frame latency.
    contour_candidates: List[Tuple[float, float, float]] = []
    if len(bubble_sized) < 110:
        contour_candidates = _contour_circle_candidates(adaptive, left, top)
        candidates.extend(contour_candidates)
        circles = _deduplicate_circles(candidates)
    if len(circles) < 80:
        raise OmrRejected(
            "Too few printed bubble rings are visible",
            {
                "houghCandidates": hough_count,
                "contourCandidates": len(contour_candidates),
                "bubbleCandidates": int(len(circles)),
            },
        )

    # Question numbers form smaller pseudo-circles.  Retaining the upper radius
    # population is what prevents the historic “number + A/B/C = A/B/C/D”
    # one-column shift.
    radius_reference = float(np.percentile(circles[:, 2], 65))
    radius_floor = max(8.8, min(11.3, radius_reference * 0.76))
    bubble_sized = circles[circles[:, 2] >= radius_floor]
    if len(bubble_sized) < 70:
        raise OmrRejected(
            "Printed bubble geometry is not sharp enough",
            {
                "bubbleCandidates": int(len(circles)),
                "bubbleSizedCandidates": int(len(bubble_sized)),
                "radiusFloor": round(radius_floor, 3),
            },
        )
    return bubble_sized, adaptive, {
        "houghCandidates": hough_count,
        "contourCandidates": len(contour_candidates),
        "bubbleCandidates": int(len(circles)),
        "bubbleSizedCandidates": int(len(bubble_sized)),
        "radiusFloor": round(radius_floor, 3),
        "medianRadius": round(float(np.median(bubble_sized[:, 2])), 3),
        "claheUsed": clahe_used,
        "roiIntensityRange": round(local_range, 3),
    }


def _profile_coordinates(length: int) -> np.ndarray:
    cached = _PROFILE_COORD_CACHE.get(length)
    if cached is None:
        cached = np.arange(length, dtype=np.float32)
        _PROFILE_COORD_CACHE[length] = cached
    return cached


def _fit_periodic_profile(
    values: np.ndarray,
    length: int,
    start_low: float,
    start_high: float,
    spacing_low: float,
    spacing_high: float,
    count: int,
    sigma: float = 2.0,
) -> Tuple[float, float, float]:
    if values.size < count:
        raise OmrRejected("Not enough printed rings to fit the answer grid")
    indices = np.clip(np.rint(values).astype(np.int32), 0, length - 1)
    profile = np.bincount(indices, minlength=length).astype(np.float32)
    profile = cv2.GaussianBlur(profile.reshape(1, -1), (0, 0), sigma).reshape(-1)

    starts = np.arange(start_low, start_high, 0.5, dtype=np.float32)
    spacings = np.arange(spacing_low, spacing_high, 0.1, dtype=np.float32)
    positions = (
        starts[:, None, None]
        + spacings[None, :, None] * np.arange(count, dtype=np.float32)[None, None, :]
    )
    scores = np.interp(
        positions.reshape(-1), _profile_coordinates(length), profile
    ).reshape(len(starts), len(spacings), count).sum(axis=2)
    best_start, best_spacing = np.unravel_index(np.argmax(scores), scores.shape)
    return (
        float(scores[best_start, best_spacing]),
        float(starts[best_start]),
        float(spacings[best_spacing]),
    )


def _refine_block_lattice(
    points: np.ndarray,
    y_fit: Tuple[float, float, float],
    x_fit: Tuple[float, float, float],
) -> Dict[str, Any]:
    y0, row_spacing = y_fit[1], y_fit[2]
    x0, choice_spacing = x_fit[1], x_fit[2]
    x_coeff = np.asarray([x0, choice_spacing, 0.0], dtype=np.float64)
    y_coeff = np.asarray([y0, row_spacing, 0.0], dtype=np.float64)

    selected_cells: Dict[Tuple[int, int], np.ndarray] = {}
    for _ in range(2):
        selected_cells = {}
        for point in points:
            expected_x = (
                x_coeff[0]
                + x_coeff[1] * np.arange(4, dtype=np.float64)
                + x_coeff[2] * 12.0
            )
            expected_y = (
                y_coeff[0]
                + y_coeff[1] * np.arange(25, dtype=np.float64)
                + y_coeff[2] * 1.5
            )
            lane = int(np.argmin(np.abs(expected_x - point[0])))
            row = int(np.argmin(np.abs(expected_y - point[1])))
            predicted_x = x_coeff[0] + x_coeff[1] * lane + x_coeff[2] * row
            predicted_y = y_coeff[0] + y_coeff[1] * row + y_coeff[2] * lane
            dx = abs(float(point[0]) - predicted_x)
            dy = abs(float(point[1]) - predicted_y)
            if dx > 7.0 or dy > 6.0:
                continue
            distance = dx * dx + dy * dy
            key = (row, lane)
            previous = selected_cells.get(key)
            if previous is None or distance < previous[3]:
                selected_cells[key] = np.asarray(
                    [point[0], point[1], point[2], distance], dtype=np.float64
                )

        if len(selected_cells) < 45:
            break
        rows = np.asarray([key[0] for key in selected_cells], dtype=np.float64)
        lanes = np.asarray([key[1] for key in selected_cells], dtype=np.float64)
        observed_x = np.asarray([value[0] for value in selected_cells.values()])
        observed_y = np.asarray([value[1] for value in selected_cells.values()])
        design_x = np.column_stack((np.ones_like(rows), lanes, rows))
        design_y = np.column_stack((np.ones_like(rows), rows, lanes))
        candidate_x = np.linalg.lstsq(design_x, observed_x, rcond=None)[0]
        candidate_y = np.linalg.lstsq(design_y, observed_y, rcond=None)[0]
        if (
            32.0 <= candidate_x[1] <= 47.0
            and abs(candidate_x[2]) <= 0.45
            and 33.0 <= candidate_y[1] <= 43.0
            and abs(candidate_y[2]) <= 1.2
        ):
            x_coeff = candidate_x
            y_coeff = candidate_y

    support = np.zeros((25, 4), dtype=np.uint8)
    for row, lane in selected_cells:
        support[row, lane] = 1
    centers = np.empty((25, 4, 2), dtype=np.float32)
    for row in range(25):
        for lane in range(4):
            centers[row, lane] = (
                x_coeff[0] + x_coeff[1] * lane + x_coeff[2] * row,
                y_coeff[0] + y_coeff[1] * row + y_coeff[2] * lane,
            )
    return {
        "centers": centers,
        "support": support,
        "xCoefficients": [round(float(value), 5) for value in x_coeff],
        "yCoefficients": [round(float(value), 5) for value in y_coeff],
        "cellSupport": int(support.sum()),
        "rowSupport": int(np.sum(support.sum(axis=1) >= 2)),
        "laneSupport": [int(value) for value in support.sum(axis=0)],
    }


def _fit_answer_grid(circles: np.ndarray) -> Tuple[np.ndarray, Dict[str, Any]]:
    blocks = []
    definitions = (
        (40.0, 370.0, 70.0, 190.0),
        (380.0, 750.0, 400.0, 590.0),
    )
    for block_index, (region_left, region_right, start_left, start_right) in enumerate(definitions):
        block_points = circles[
            (circles[:, 0] >= region_left) & (circles[:, 0] <= region_right)
        ]
        if len(block_points) < 30:
            raise OmrRejected(
                f"Answer block {block_index + 1} is not fully visible",
                {"block": block_index + 1, "ringCandidates": int(len(block_points))},
            )
        if block_index == 0:
            y_start_low, y_start_high = 250.0, 350.0
            y_spacing_low, y_spacing_high = 34.0, 42.0
        else:
            # Both printed blocks share the same 25 physical rows. This
            # cross-block anchor prevents a very regular 26–50 lattice from
            # being mislabeled as 25–49 when the last printed row is faint.
            left_profile = blocks[0]["profileY"]
            y_start_low = max(250.0, left_profile[1] - 20.0)
            y_start_high = min(350.0, left_profile[1] + 20.5)
            y_spacing_low = max(34.0, left_profile[2] - 1.6)
            y_spacing_high = min(42.0, left_profile[2] + 1.7)
        y_fit = _fit_periodic_profile(
            block_points[:, 1],
            CANONICAL_HEIGHT,
            y_start_low,
            y_start_high,
            y_spacing_low,
            y_spacing_high,
            25,
        )
        expected_rows = y_fit[1] + np.arange(25, dtype=np.float32) * y_fit[2]
        row_distance = np.min(
            np.abs(block_points[:, 1, None] - expected_rows[None, :]), axis=1
        )
        near_rows = block_points[row_distance <= 5.5]
        x_fit = _fit_periodic_profile(
            near_rows[:, 0],
            CANONICAL_WIDTH,
            start_left,
            start_right,
            33,
            47,
            4,
        )
        refined = _refine_block_lattice(near_rows, y_fit, x_fit)
        refined["profileY"] = [round(value, 5) for value in y_fit]
        refined["profileX"] = [round(value, 5) for value in x_fit]
        refined["candidateCount"] = int(len(near_rows))
        blocks.append(refined)

    centers = np.concatenate((blocks[0]["centers"], blocks[1]["centers"]), axis=0)
    total_cell_support = blocks[0]["cellSupport"] + blocks[1]["cellSupport"]
    total_row_support = blocks[0]["rowSupport"] + blocks[1]["rowSupport"]
    valid_lane_groups = sum(
        1
        for block in blocks
        if sum(value >= 9 for value in block["laneSupport"]) >= 3
    )
    row_spacing_delta = abs(
        blocks[0]["yCoefficients"][1] - blocks[1]["yCoefficients"][1]
    )
    top_row_delta = abs(
        blocks[0]["yCoefficients"][0] - blocks[1]["yCoefficients"][0]
    )
    left_last = float(np.max(blocks[0]["centers"][:, 3, 0]))
    right_first = float(np.min(blocks[1]["centers"][:, 0, 0]))

    if (
        total_cell_support < 92
        or total_row_support < 42
        or valid_lane_groups < 2
        or row_spacing_delta > 1.8
        or top_row_delta > 22.0
        or right_first - left_last < 55
    ):
        raise OmrRejected(
            "Printed bubble grid could not be verified without guessing",
            {
                "cellSupport": total_cell_support,
                "rowSupport": total_row_support,
                "validLaneGroups": valid_lane_groups,
                "rowSpacingDelta": round(float(row_spacing_delta), 4),
                "topRowDelta": round(float(top_row_delta), 4),
                "blockDetails": [
                    {
                        key: value
                        for key, value in block.items()
                        if key not in ("centers", "support")
                    }
                    for block in blocks
                ],
            },
        )

    cell_score = min(1.0, total_cell_support / 145.0)
    row_score = total_row_support / 50.0
    geometry_confidence = 100.0 * (0.62 * cell_score + 0.38 * row_score)
    return centers, {
        "verified": True,
        "cellSupport": total_cell_support,
        "rowSupport": total_row_support,
        "confidence": round(min(99.0, geometry_confidence), 2),
        "blocks": [
            {
                key: value
                for key, value in block.items()
                if key not in ("centers", "support")
            }
            for block in blocks
        ],
    }


def _extract_features(
    warped: np.ndarray, adaptive: np.ndarray, centers: np.ndarray
) -> Tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, List[np.ndarray]]:
    left, top, _, _ = ANSWER_ROI
    means = np.zeros((50, 4), dtype=np.float32)
    paper = np.zeros((50, 4), dtype=np.float32)
    adaptive_fill = np.zeros((50, 4), dtype=np.float32)
    dark_fraction = np.zeros((50, 4), dtype=np.float32)
    patches: List[np.ndarray] = []
    for row in range(50):
        for lane in range(4):
            x, y = (float(value) for value in centers[row, lane])
            if x < 16 or x > CANONICAL_WIDTH - 17 or y < 16 or y > CANONICAL_HEIGHT - 17:
                raise OmrRejected("A fitted answer bubble falls outside the visible page")
            patch = cv2.getRectSubPix(warped, (29, 29), (x, y))
            adaptive_patch = cv2.getRectSubPix(
                adaptive, (29, 29), (x - left, y - top)
            )
            inner = patch[_INNER_MASK]
            local_paper = float(np.percentile(patch[_CORNER_MASK], 75))
            means[row, lane] = float(np.mean(inner))
            paper[row, lane] = local_paper
            adaptive_fill[row, lane] = float(
                np.mean(adaptive_patch[_INNER_MASK] > 0)
            )
            dark_fraction[row, lane] = float(
                np.mean(inner < max(25.0, local_paper - 38.0))
            )
            patches.append(patch)
    return means, paper, adaptive_fill, dark_fraction, patches


def _two_cluster_threshold(values: np.ndarray) -> Tuple[Optional[float], Dict[str, Any]]:
    samples = values.reshape(-1, 1).astype(np.float32)
    criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 30, 0.05)
    cv2.setRNGSeed(20260724)
    _, _, centers = cv2.kmeans(
        samples, 2, None, criteria, 5, cv2.KMEANS_PP_CENTERS
    )
    centers = np.sort(centers.reshape(-1))
    separation = float(centers[1] - centers[0])
    midpoint = float(np.mean(centers))
    dark_fraction = float(np.mean(samples.reshape(-1) < midpoint))
    usable = separation >= 32.0 and 0.025 <= dark_fraction <= 0.68
    return (midpoint if usable else None), {
        "darkCenter": round(float(centers[0]), 3),
        "lightCenter": round(float(centers[1]), 3),
        "separation": round(separation, 3),
        "darkFraction": round(dark_fraction, 4),
        "usable": usable,
    }


def _softmax(logits: np.ndarray) -> np.ndarray:
    shifted = logits - np.max(logits, axis=1, keepdims=True)
    exponential = np.exp(shifted)
    return exponential / np.maximum(1e-8, exponential.sum(axis=1, keepdims=True))


def _perceptual_header_hash(warped: np.ndarray) -> str:
    """Exposure-resistant 64-bit pHash for new-sheet/duplicate handling."""

    header = warped[35:230, 70:730]
    reduced = cv2.resize(header, (32, 32), interpolation=cv2.INTER_AREA).astype(np.float32)
    coefficients = cv2.dct(reduced)[:8, :8]
    median = float(np.median(coefficients.reshape(-1)[1:]))
    bits = (coefficients >= median).reshape(-1).astype(np.uint8)
    return np.packbits(bits).tobytes().hex()


def _get_cnn_net():
    global _CNN_NET, _CNN_LOAD_ATTEMPTED
    if _CNN_LOAD_ATTEMPTED:
        return _CNN_NET
    _CNN_LOAD_ATTEMPTED = True
    if not MODEL_PATH.exists():
        return None
    try:
        # OpenCV-DNN reuses the already loaded native runtime and needs only a
        # few MiB for this 622 KiB model. onnxruntime added roughly 250 MiB RSS
        # to the persistent worker on the target development machine.
        _CNN_NET = cv2.dnn.readNetFromONNX(str(MODEL_PATH))
    except Exception as error:  # pragma: no cover - availability is reported
        print(f"[FAST-OMR] ONNX unavailable: {error}", file=sys.stderr, flush=True)
        _CNN_NET = None
    return _CNN_NET


def _cnn_probabilities(patches: Sequence[np.ndarray]) -> Optional[np.ndarray]:
    network = _get_cnn_net()
    if network is None or not patches:
        return None
    prepared = np.empty((len(patches), 1, 32, 32), dtype=np.float32)
    sharpen = np.asarray([[0, -1, 0], [-1, 5, -1], [0, -1, 0]], dtype=np.float32)
    for index, patch in enumerate(patches):
        resized = cv2.resize(patch, (32, 32), interpolation=cv2.INTER_AREA)
        normalized = cv2.normalize(resized, None, 0, 255, cv2.NORM_MINMAX)
        normalized = cv2.filter2D(normalized, -1, sharpen)
        prepared[index, 0] = normalized.astype(np.float32) / 255.0
    network.setInput(prepared)
    output = np.asarray(network.forward(), dtype=np.float32)
    if output.ndim != 2 or output.shape[1] < 2:
        return None
    row_sums = output.sum(axis=1)
    if np.any(output < 0) or np.any(output > 1) or not np.allclose(row_sums, 1, atol=0.08):
        output = _softmax(output)
    return output[:, 1]


def _classify_rows(
    means: np.ndarray,
    paper: np.ndarray,
    adaptive_fill: np.ndarray,
    dark_fraction: np.ndarray,
    patches: Sequence[np.ndarray],
    use_cnn: bool,
) -> Dict[str, Any]:
    global_threshold, clustering = _two_cluster_threshold(means)
    global_mark = (
        means < global_threshold
        if global_threshold is not None
        else np.zeros_like(means, dtype=bool)
    )
    local_contrast = paper - means

    answers = [""] * 50
    marked_letters: List[List[str]] = [[] for _ in range(50)]
    states = ["uncertain"] * 50
    confidence = np.zeros(50, dtype=np.float32)
    uncertain_rows: List[int] = []
    possible_counts = np.zeros(50, dtype=np.uint8)
    strong_counts = np.zeros(50, dtype=np.uint8)
    possible_masks = np.zeros_like(means, dtype=bool)
    relative_darkness = np.zeros_like(means, dtype=np.float32)
    diagnostics: List[Dict[str, Any]] = []

    for row in range(50):
        row_means = means[row]
        light_baseline = float(np.median(np.sort(row_means)[-2:]))
        relative = light_baseline - row_means
        order = np.argsort(row_means)
        top_gap = float(row_means[order[1]] - row_means[order[0]])
        spread = float(np.max(row_means) - np.min(row_means))
        # Absolute grayscale thresholds are deliberately excluded: camera
        # exposure can move an unmarked bubble from 210 to 110 without
        # changing its meaning.  Marks need both row-relative separation and,
        # near the boundary, membership in the sheet's dark cluster.
        strong = (relative >= 30.0) | ((relative >= 18.0) & global_mark[row])
        possible = (relative >= 18.0) | global_mark[row]
        strong_indices = np.flatnonzero(strong).tolist()
        possible_indices = np.flatnonzero(possible).tolist()
        possible_counts[row] = len(possible_indices)
        strong_counts[row] = len(strong_indices)
        possible_masks[row] = possible
        relative_darkness[row] = relative

        if len(strong_indices) == 1 and len(possible_indices) == 1:
            selected = strong_indices[0]
            answers[row] = CHOICES[selected]
            marked_letters[row] = [CHOICES[selected]]
            states[row] = "single"
            confidence[row] = min(99.0, max(72.0, 58.0 + 0.55 * top_gap))
        elif len(strong_indices) >= 2:
            marked_letters[row] = [CHOICES[index] for index in strong_indices]
            states[row] = "multiple"
            confidence[row] = min(
                99.0, max(75.0, 58.0 + 0.45 * float(np.min(relative[strong])))
            )
        elif not possible_indices and spread <= 24.0:
            states[row] = "blank"
            confidence[row] = min(98.0, max(72.0, 98.0 - 1.05 * spread))
        else:
            marked_letters[row] = [CHOICES[index] for index in possible_indices]
            confidence[row] = 0.0
            uncertain_rows.append(row)

        diagnostics.append(
            {
                "state": states[row],
                "mean": [round(float(value), 3) for value in row_means],
                "relativeDarkness": [round(float(value), 3) for value in relative],
                "adaptiveFill": [
                    round(float(value), 4) for value in adaptive_fill[row]
                ],
                "darkFraction": [
                    round(float(value), 4) for value in dark_fraction[row]
                ],
                "topGap": round(top_gap, 3),
                "cvPossibleCount": len(possible_indices),
            }
        )

    ai_checked_rows = 0
    ai_resolved_rows = 0
    if use_cnn and uncertain_rows:
        ambiguous_patches: List[np.ndarray] = []
        for row in uncertain_rows:
            ambiguous_patches.extend(patches[row * 4 : row * 4 + 4])
        probabilities = _cnn_probabilities(ambiguous_patches)
        if probabilities is not None:
            probabilities = probabilities.reshape(len(uncertain_rows), 4)
            ai_checked_rows = len(uncertain_rows)
            still_uncertain: List[int] = []
            for result_index, row in enumerate(uncertain_rows):
                row_probabilities = probabilities[result_index]
                ranked = np.argsort(row_probabilities)[::-1]
                selected = int(ranked[0])
                second = int(ranked[1])
                classical = int(np.argmin(means[row]))
                top_gap = float(
                    np.partition(means[row], 1)[1] - np.min(means[row])
                )
                cnn_marks = np.flatnonzero(row_probabilities >= 0.90).tolist()
                extra_possible = [
                    index
                    for index in np.flatnonzero(possible_masks[row]).tolist()
                    if index != selected
                ]
                # A warped/blurred printed ring sometimes produces a weak
                # 18-20 level "possible" candidate. Permit the CNN to suppress
                # it only when three independent ring-artifact features agree.
                # Faint second marks fail these gates and remain uncertain.
                only_ring_artifact_extras = bool(extra_possible) and all(
                    relative_darkness[row, index] < 22.0
                    and dark_fraction[row, index] >= 0.40
                    and (
                        dark_fraction[row, index]
                        / max(0.0001, adaptive_fill[row, index])
                    )
                    >= 0.62
                    and row_probabilities[index] <= 0.02
                    for index in extra_possible
                )
                diagnostics[row]["cnnMarkedProbability"] = [
                    round(float(value), 5) for value in row_probabilities
                ]
                if (
                    len(cnn_marks) == 1
                    and (
                        possible_counts[row] <= 1
                        or only_ring_artifact_extras
                    )
                    and selected == classical
                    and row_probabilities[selected] >= 0.94
                    and row_probabilities[second] <= 0.20
                    and top_gap >= 12.0
                ):
                    answers[row] = CHOICES[selected]
                    marked_letters[row] = [CHOICES[selected]]
                    states[row] = "single"
                    confidence[row] = min(
                        96.0,
                        55.0
                        + 35.0 * float(row_probabilities[selected])
                        + 0.25 * top_gap,
                    )
                    ai_resolved_rows += 1
                elif len(cnn_marks) >= 2:
                    marked_letters[row] = [CHOICES[index] for index in cnn_marks]
                    states[row] = "multiple"
                    confidence[row] = min(
                        96.0,
                        65.0
                        + 25.0
                        * float(min(row_probabilities[index] for index in cnn_marks)),
                    )
                    ai_resolved_rows += 1
                elif (
                    float(np.max(row_probabilities)) <= 0.20
                    and top_gap <= 12.0
                    and (
                        possible_counts[row] == 0
                        or (
                            strong_counts[row] == 0
                            and possible_counts[row] >= 3
                            and float(np.max(dark_fraction[row])) <= 0.38
                        )
                    )
                ):
                    marked_letters[row] = []
                    states[row] = "blank"
                    confidence[row] = 90.0
                    ai_resolved_rows += 1
                else:
                    still_uncertain.append(row)
            uncertain_rows = still_uncertain

    for row in range(50):
        diagnostics[row]["state"] = states[row]

    return {
        "answers": answers,
        "markedLetters": marked_letters,
        "rowStates": states,
        "confidenceScores": [round(float(value), 2) for value in confidence],
        "blankRows": int(sum(state == "blank" for state in states)),
        "multipleRows": int(sum(state == "multiple" for state in states)),
        "uncertainRows": len(uncertain_rows),
        "markedRows": int(sum(state in ("single", "multiple") for state in states)),
        "uncertainRowNumbers": [row + 1 for row in uncertain_rows],
        "featureClustering": clustering,
        "aiVerification": {
            "model": "onnx-bubble-classifier",
            "mode": "ambiguous-rows-batched",
            "available": _get_cnn_net() is not None if use_cnn and uncertain_rows else MODEL_PATH.exists(),
            "checkedRows": ai_checked_rows,
            "resolvedRows": ai_resolved_rows,
        },
        "rowDiagnostics": diagnostics,
    }


def scan_image(image_bytes: bytes, options: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    options = options or {}
    started = time.perf_counter()
    stages: Dict[str, float] = {}
    placement: Optional[Dict[str, Any]] = None
    try:
        decode_started = time.perf_counter()
        encoded = np.frombuffer(image_bytes, dtype=np.uint8)
        gray = cv2.imdecode(encoded, cv2.IMREAD_GRAYSCALE)
        if gray is None or gray.size == 0:
            raise OmrRejected("Image could not be decoded")
        stages["decode"] = _stage_ms(decode_started)

        page_started = time.perf_counter()
        warped, placement = _locate_and_warp(gray)
        stages["pageAndPerspective"] = _stage_ms(page_started)
        if not placement.get("acceptable"):
            raise OmrRejected(
                "Center the visible answer sheet inside the camera frame",
                {"placement": placement},
            )

        grid_started = time.perf_counter()
        circles, adaptive, locator_details = _find_bubble_candidates(warped)
        centers, geometry = _fit_answer_grid(circles)
        stages["gridLocation"] = _stage_ms(grid_started)

        classify_started = time.perf_counter()
        means, paper, adaptive_fill, dark_fraction, patches = _extract_features(
            warped, adaptive, centers
        )
        classification = _classify_rows(
            means,
            paper,
            adaptive_fill,
            dark_fraction,
            patches,
            bool(options.get("useCnn", True)),
        )
        stages["classification"] = _stage_ms(classify_started)

        mark_confidences = np.asarray(
            classification["confidenceScores"], dtype=np.float32
        )
        average_confidence = float(np.mean(mark_confidences)) if len(mark_confidences) else 0.0
        total_ms = _stage_ms(started)
        return {
            "success": True,
            "source": "fast-hybrid-grid",
            "formLayout": FORM_LAYOUT,
            "answers": classification["answers"],
            "confidenceScores": classification["confidenceScores"],
            "markedLetters": classification["markedLetters"],
            "rowStates": classification["rowStates"],
            "averageConfidence": round(average_confidence, 2),
            "geometryVerified": True,
            "currentSheetGeometry": True,
            "geometryConfidence": geometry["confidence"],
            "blankRows": classification["blankRows"],
            "ambiguousRows": classification["multipleRows"],
            "multipleRows": classification["multipleRows"],
            "uncertainRows": classification["uncertainRows"],
            "uncertainRowNumbers": classification["uncertainRowNumbers"],
            "markedRows": classification["markedRows"],
            "placement": placement,
            "sheetFingerprint": _perceptual_header_hash(warped),
            "grid": geometry,
            "locator": locator_details,
            "featureClustering": classification["featureClustering"],
            "aiVerification": classification["aiVerification"],
            "rowDiagnostics": classification["rowDiagnostics"]
            if bool(options.get("includeDiagnostics", False))
            else None,
            "centers": [
                [
                    [round(float(x), 3), round(float(y), 3)]
                    for x, y in centers[row]
                ]
                for row in range(50)
            ],
            "processingMs": total_ms,
            "stagesMs": stages,
        }
    except OmrRejected as error:
        details = dict(error.details)
        if placement is not None and "placement" not in details:
            details["placement"] = placement
        return {
            "success": False,
            "source": "fast-hybrid-grid-rejected",
            "formLayout": FORM_LAYOUT,
            "reason": error.reason,
            "geometryVerified": False,
            "answers": [],
            "confidenceScores": [],
            "markedLetters": [],
            "processingMs": _stage_ms(started),
            "stagesMs": stages,
            **details,
        }
    except Exception as error:  # fail closed, but keep a useful diagnostic
        return {
            "success": False,
            "source": "fast-hybrid-grid-error",
            "formLayout": FORM_LAYOUT,
            "reason": f"Fast OMR failed: {error}",
            "geometryVerified": False,
            "answers": [],
            "confidenceScores": [],
            "markedLetters": [],
            "processingMs": _stage_ms(started),
            "stagesMs": stages,
        }


def _read_exact(stream, length: int) -> Optional[bytes]:
    chunks = bytearray()
    while len(chunks) < length:
        chunk = stream.read(length - len(chunks))
        if not chunk:
            return None
        chunks.extend(chunk)
    return bytes(chunks)


def _read_u32(stream) -> Optional[int]:
    value = _read_exact(stream, 4)
    return struct.unpack(">I", value)[0] if value is not None else None


def _write_response(stream, payload: Dict[str, Any]) -> None:
    encoded = json.dumps(payload, separators=(",", ":"), allow_nan=False).encode("utf-8")
    stream.write(struct.pack(">I", len(encoded)))
    stream.write(encoded)
    stream.flush()


def worker_loop() -> int:
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
            header = json.loads(header_bytes.decode("utf-8"))
            result = scan_image(image_bytes, header)
            result["id"] = header.get("id")
        except Exception as error:
            result = {
                "id": None,
                "success": False,
                "source": "fast-hybrid-grid-error",
                "reason": str(error),
            }
        _write_response(output_stream, result)


def main() -> int:
    parser = argparse.ArgumentParser(description="AcadCheck fast hybrid OMR")
    parser.add_argument("image", nargs="?", help="Image path, or '-' for stdin")
    parser.add_argument("--worker", action="store_true", help="Run persistent binary worker")
    parser.add_argument("--no-cnn", action="store_true", help="Disable ambiguous-row CNN")
    parser.add_argument(
        "--diagnostics", action="store_true", help="Include per-row feature diagnostics"
    )
    args = parser.parse_args()
    if args.worker:
        return worker_loop()
    if not args.image:
        parser.error("image is required unless --worker is used")
    image_bytes = (
        sys.stdin.buffer.read()
        if args.image == "-"
        else Path(args.image).read_bytes()
    )
    result = scan_image(
        image_bytes,
        {"useCnn": not args.no_cnn, "includeDiagnostics": args.diagnostics},
    )
    print(json.dumps(result, indent=2))
    return 0 if result.get("success") else 1


if __name__ == "__main__":
    raise SystemExit(main())
