#!/usr/bin/env python3
"""Reproducible accuracy, robustness, latency, CPU, and RSS benchmark."""

from __future__ import annotations

import argparse
import json
import math
import os
import struct
import subprocess
import statistics
import sys
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, Iterator, List, Sequence, Set, Tuple

import cv2
import numpy as np

import fast_omr_worker as omr

ROOT = Path(__file__).resolve().parents[1]
REAL_SCANS = ROOT / "ml-training" / "real_scans"
TRUTHS = {
    "allA.jpg": "A" * 50,
    "allB.jpg": "B" * 50,
    "allC.jpg": "C" * 50,
    "allD.jpg": "D" * 50,
    "random.jpg": "DBACBDACDBACDACCABDCBADCBADCBADCBADCBBACDCBBADCBCB",
}


def encode(image: np.ndarray, quality: int = 75) -> bytes:
    ok, encoded = cv2.imencode(
        ".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, int(quality)]
    )
    if not ok:
        raise RuntimeError("Could not encode benchmark image")
    return encoded.tobytes()


def normal_variants(image: np.ndarray) -> Iterable[Tuple[str, np.ndarray]]:
    height, width = image.shape[:2]
    yield "original", image
    for angle in (-3, 3):
        matrix = cv2.getRotationMatrix2D((width / 2, height / 2), angle, 1.0)
        yield f"rotation_{angle:+d}", cv2.warpAffine(
            image, matrix, (width, height), borderValue=(25, 25, 25)
        )
    yield "dark_0.72", cv2.convertScaleAbs(image, alpha=0.72, beta=0)
    yield "bright_1.10", cv2.convertScaleAbs(image, alpha=1.10, beta=10)

    illumination = np.linspace(0.75, 1.10, width, dtype=np.float32)[None, :, None]
    yield "lighting_gradient", np.clip(
        image.astype(np.float32) * illumination, 0, 255
    ).astype(np.uint8)

    source = np.float32(
        [[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]]
    )
    destination = np.float32(
        [[40, 20], [width - 41, 0], [width - 1, height - 1], [0, height - 21]]
    )
    yield "slight_perspective", cv2.warpPerspective(
        image,
        cv2.getPerspectiveTransform(source, destination),
        (width, height),
        borderValue=(25, 25, 25),
    )

    smaller = cv2.resize(image, None, fx=0.78, fy=0.78, interpolation=cv2.INTER_AREA)
    distant = np.full_like(image, 25)
    top = (height - smaller.shape[0]) // 2
    left = (width - smaller.shape[1]) // 2
    distant[top : top + smaller.shape[0], left : left + smaller.shape[1]] = smaller
    yield "distance_0.78", distant
    yield "blur_5x5", cv2.GaussianBlur(image, (5, 5), 1.1)


def _transform_points(points: np.ndarray, transform: np.ndarray) -> np.ndarray:
    return cv2.perspectiveTransform(
        np.asarray(points, dtype=np.float32).reshape(-1, 1, 2),
        np.asarray(transform, dtype=np.float64),
    ).reshape(points.shape)


def _crop_transform(left: int, top: int) -> np.ndarray:
    return np.asarray(
        [[1.0, 0.0, -float(left)], [0.0, 1.0, -float(top)], [0.0, 0.0, 1.0]],
        dtype=np.float64,
    )


def _crop_case(
    image: np.ndarray,
    bounds: Tuple[int, int, int, int],
    source_to_current: np.ndarray,
) -> Tuple[np.ndarray, np.ndarray]:
    height, width = image.shape[:2]
    left, top, right, bottom = bounds
    left = max(0, min(width - 2, int(left)))
    top = max(0, min(height - 2, int(top)))
    right = max(left + 2, min(width, int(right)))
    bottom = max(top + 2, min(height, int(bottom)))
    return (
        image[top:bottom, left:right].copy(),
        _crop_transform(left, top) @ source_to_current,
    )


def _resize_long_edge(
    image: np.ndarray,
    source_to_current: np.ndarray,
    long_edge: int,
) -> Tuple[np.ndarray, np.ndarray]:
    scale = min(1.0, float(long_edge) / max(image.shape[:2]))
    if scale >= 0.999:
        return image.copy(), source_to_current.copy()
    resized = cv2.resize(
        image,
        None,
        fx=scale,
        fy=scale,
        interpolation=cv2.INTER_AREA,
    )
    resize_transform = np.asarray(
        [[scale, 0.0, 0.0], [0.0, scale, 0.0], [0.0, 0.0, 1.0]],
        dtype=np.float64,
    )
    return resized, resize_transform @ source_to_current


def _rotate_in_frame(
    image: np.ndarray,
    source_to_current: np.ndarray,
    angle: float,
) -> Tuple[np.ndarray, np.ndarray]:
    height, width = image.shape[:2]
    center = (width / 2.0, height / 2.0)
    affine = cv2.getRotationMatrix2D(center, angle, 1.0)
    rotated = cv2.warpAffine(
        image,
        affine,
        (width, height),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=(25, 25, 25),
    )
    transform = np.vstack([affine, [0.0, 0.0, 1.0]])
    return rotated, transform @ source_to_current


def _perspective_case(
    image: np.ndarray,
    source_to_current: np.ndarray,
) -> Tuple[np.ndarray, np.ndarray]:
    height, width = image.shape[:2]
    source = np.float32(
        [[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]]
    )
    destination = np.float32(
        [
            [width * 0.018, height * 0.008],
            [width - 1, height * 0.035],
            [width * 0.965, height - 1],
            [0, height * 0.975],
        ]
    )
    transform = cv2.getPerspectiveTransform(source, destination)
    warped = cv2.warpPerspective(
        image,
        transform,
        (width, height),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=(25, 25, 25),
    )
    return warped, transform @ source_to_current


def _lighting_case(image: np.ndarray) -> np.ndarray:
    height, width = image.shape[:2]
    horizontal = np.linspace(0.66, 1.08, width, dtype=np.float32)[None, :]
    vertical = np.linspace(1.05, 0.83, height, dtype=np.float32)[:, None]
    illumination = horizontal * vertical
    return np.clip(
        image.astype(np.float32) * illumination[:, :, None] + 4.0,
        0,
        255,
    ).astype(np.uint8)


def _partial_source_geometry(
    image: np.ndarray,
) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Recover trusted bubble patches in source-image coordinates.

    The trusted full capture is localized with ``allow_clipped=True`` solely
    to construct deterministic benchmark crops.  The images produced below
    are still sent through the public scanner from scratch.
    """

    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    canonical, placement = omr._locate_and_warp(gray, allow_clipped=True)
    circles, _, _ = omr._find_bubble_candidates(canonical)
    centers, _ = omr._fit_answer_grid(circles)
    source_to_canonical = np.asarray(
        placement["perspectiveTransform"], dtype=np.float64
    )
    canonical_to_source = np.linalg.inv(source_to_canonical)

    offsets = np.asarray(
        [[-14, -14], [14, -14], [14, 14], [-14, 14]], dtype=np.float32
    )
    patch_corners = (
        centers[:, :, None, :].astype(np.float32)
        + offsets[None, None, :, :]
    )
    source_patch_corners = _transform_points(
        patch_corners, canonical_to_source
    )
    page_corners = np.asarray(placement["corners"], dtype=np.float32)
    return source_patch_corners, centers.astype(np.float32), page_corners


def _case_visibility(
    source_patch_corners: np.ndarray,
    source_to_variant: np.ndarray,
    variant_shape: Tuple[int, ...],
) -> Tuple[float, List[int]]:
    transformed = _transform_points(source_patch_corners, source_to_variant)
    height, width = variant_shape[:2]
    point_inside = (
        (transformed[..., 0] >= 0.0)
        & (transformed[..., 0] <= width - 1.0)
        & (transformed[..., 1] >= 0.0)
        & (transformed[..., 1] <= height - 1.0)
    )
    bubble_visible = point_inside.all(axis=2)
    question_visible = bubble_visible.all(axis=1)
    outside = [
        int(question + 1)
        for question, visible in enumerate(question_visible)
        if not bool(visible)
    ]
    return float(np.mean(bubble_visible)), outside


def partial_document_variants(
    image: np.ndarray,
) -> Tuple[Iterable[Dict[str, object]], Iterable[Dict[str, object]]]:
    """Build valid borderless captures and deliberately invalid controls."""

    source_patches, _, page_corners = _partial_source_geometry(image)
    height, width = image.shape[:2]
    patch_points = source_patches.reshape(-1, 2)
    patch_min = patch_points.min(axis=0)
    patch_max = patch_points.max(axis=0)
    page_min = page_corners.min(axis=0)
    page_max = page_corners.max(axis=0)

    # Place each crop edge strictly between the projected physical page edge
    # and the nearest answer patch.  Thus the paper outline is absent while a
    # geometric assertion below proves every 29x29 answer patch is retained.
    left_cut = int(round((float(page_min[0]) + float(patch_min[0])) * 0.5))
    top_cut = int(round((float(page_min[1]) + float(patch_min[1])) * 0.5))
    right_cut = int(round((float(page_max[0]) + float(patch_max[0])) * 0.5))
    bottom_cut = int(round((float(page_max[1]) + float(patch_max[1])) * 0.5))

    answer_width = float(patch_max[0] - patch_min[0])
    answer_height = float(patch_max[1] - patch_min[1])
    tight_bounds = (
        int(math.floor(patch_min[0] - max(18.0, answer_width * 0.12))),
        int(math.floor(patch_min[1] - max(18.0, answer_height * 0.065))),
        int(math.ceil(patch_max[0] + max(18.0, answer_width * 0.12))),
        int(math.ceil(patch_max[1] + max(18.0, answer_height * 0.065))),
    )

    identity = np.eye(3, dtype=np.float64)

    def crop(
        bounds: Tuple[int, int, int, int],
    ) -> Tuple[np.ndarray, np.ndarray]:
        return _crop_case(image, bounds, identity)

    CaseBuilder = Callable[[], Tuple[np.ndarray, np.ndarray]]
    valid_builders: List[Tuple[str, CaseBuilder, str]] = []
    crop_specs = [
        ("cropped_top", (0, top_cut, width, height), "top border outside frame"),
        (
            "cropped_bottom",
            (0, 0, width, bottom_cut),
            "bottom border outside frame",
        ),
        (
            "cropped_top_bottom",
            (0, top_cut, width, bottom_cut),
            "top and bottom borders outside frame",
        ),
        (
            "cropped_left",
            (left_cut, 0, width, height),
            "left border and both left corners outside frame",
        ),
        (
            "cropped_right",
            (0, 0, right_cut, height),
            "right border and both right corners outside frame",
        ),
    ]
    for name, bounds, condition in crop_specs:
        valid_builders.append(
            (
                name,
                lambda bounds=bounds: crop(bounds),
                condition,
            )
        )

    def top_left_perspective() -> Tuple[np.ndarray, np.ndarray]:
        case_image, transform = crop(
            (left_cut, top_cut, width, height)
        )
        return _perspective_case(case_image, transform)

    valid_builders.append(
        (
            "missing_top_left_corner_perspective",
            top_left_perspective,
            "two adjacent borders cropped plus perspective",
        )
    )

    valid_builders.append(
        (
            "tight_zoomed_answer_region",
            lambda: crop(tight_bounds),
            "all page borders absent; answer region fills frame",
        )
    )

    def webcam_resolution() -> Tuple[np.ndarray, np.ndarray]:
        case_image, transform = crop(tight_bounds)
        return _resize_long_edge(case_image, transform, 1280)

    valid_builders.append(
        (
            "cropped_webcam_1280",
            webcam_resolution,
            "tight crop at a different webcam resolution",
        )
    )

    top_bottom_bounds = (0, top_cut, width, bottom_cut)

    def rotated_top_bottom() -> Tuple[np.ndarray, np.ndarray]:
        case_image, transform = crop(top_bottom_bounds)
        return _rotate_in_frame(case_image, transform, 7.0)

    valid_builders.append(
        (
            "cropped_rotation_+7",
            rotated_top_bottom,
            "cropped borders plus camera rotation",
        )
    )

    def skewed_top_bottom() -> Tuple[np.ndarray, np.ndarray]:
        case_image, transform = crop(top_bottom_bounds)
        return _perspective_case(case_image, transform)

    valid_builders.append(
        (
            "cropped_perspective_skew",
            skewed_top_bottom,
            "cropped borders plus perspective skew",
        )
    )

    def lit_top_bottom() -> Tuple[np.ndarray, np.ndarray]:
        case_image, transform = crop(top_bottom_bounds)
        return _lighting_case(case_image), transform

    valid_builders.append(
        (
            "cropped_variable_lighting",
            lit_top_bottom,
            "cropped borders plus non-uniform lighting",
        )
    )

    def valid_cases() -> Iterable[Dict[str, object]]:
        for name, builder, condition in valid_builders:
            case_image, transform = builder()
            visible_fraction, outside = _case_visibility(
                source_patches, transform, case_image.shape
            )
            if outside:
                raise AssertionError(
                    f"Valid partial case {name} accidentally crops questions {outside}"
                )
            yield {
                "name": name,
                "image": case_image,
                "condition": condition,
                "sourceToVariant": transform,
                "visibleBubblePatchFraction": visible_fraction,
                "questionsOutsideFrame": outside,
            }

    # Negative controls remove actual answer content.  A robust scanner may
    # report a structured rejection or uncertain rows, but must never return a
    # gradeable 50-question result for these frames.
    transformed_source_centers = source_patches.mean(axis=2)
    first_rows = transformed_source_centers[[0, 1, 2, 25, 26, 27]]
    last_rows = transformed_source_centers[[22, 23, 24, 47, 48, 49]]
    left_block = source_patches[:25]
    right_block = source_patches[25:]
    missing_top_cut = int(math.ceil(float(first_rows[..., 1].max()) + 2.0))
    missing_bottom_cut = int(
        math.floor(float(last_rows[..., 1].min()) - 2.0)
    )
    block_cut = int(
        round(
            (
                float(left_block[..., 0].max())
                + float(right_block[..., 0].min())
            )
            * 0.5
        )
    )
    negative_specs = [
        (
            "negative_missing_top_answer_rows",
            (0, missing_top_cut, width, height),
            "crop removes top rows from both answer blocks",
        ),
        (
            "negative_missing_bottom_answer_rows",
            (0, 0, width, missing_bottom_cut),
            "crop removes bottom rows from both answer blocks",
        ),
        (
            "negative_missing_left_answer_block",
            (block_cut, 0, width, height),
            "crop removes questions 1-25",
        ),
    ]
    def negative_cases() -> Iterable[Dict[str, object]]:
        for name, bounds, condition in negative_specs:
            case_image, transform = crop(bounds)
            visible_fraction, outside = _case_visibility(
                source_patches, transform, case_image.shape
            )
            if not outside:
                raise AssertionError(
                    f"Negative partial case {name} did not remove an answer patch"
                )
            yield {
                "name": name,
                "image": case_image,
                "condition": condition,
                "sourceToVariant": transform,
                "visibleBubblePatchFraction": visible_fraction,
                "questionsOutsideFrame": outside,
            }
    return valid_cases(), negative_cases()


def expected_sets(answer_string: str) -> List[Set[str]]:
    return [{answer} if answer else set() for answer in answer_string]


def update_confusion(
    counts: Dict[str, int], expected: Sequence[Set[str]], predicted: Sequence[Sequence[str]]
) -> int:
    exact_rows = 0
    for row in range(50):
        expected_row = expected[row]
        predicted_row = set(predicted[row]) if row < len(predicted) else set()
        if expected_row == predicted_row:
            exact_rows += 1
        for letter in omr.CHOICES:
            truth = letter in expected_row
            detection = letter in predicted_row
            if truth and detection:
                counts["tp"] += 1
            elif truth and not detection:
                counts["fn"] += 1
            elif not truth and detection:
                counts["fp"] += 1
            else:
                counts["tn"] += 1
    return exact_rows


def bubble_copy(
    target: np.ndarray,
    source: np.ndarray,
    centers: np.ndarray,
    target_row: int,
    target_lane: int,
    source_row: int,
    source_lane: int,
    source_weight: float = 1.0,
) -> None:
    target_x, target_y = np.rint(centers[target_row, target_lane]).astype(int)
    source_x, source_y = np.rint(centers[source_row, source_lane]).astype(int)
    target_patch = target[target_y - 13 : target_y + 14, target_x - 13 : target_x + 14]
    source_patch = source[source_y - 13 : source_y + 14, source_x - 13 : source_x + 14]
    yy, xx = np.ogrid[-13:14, -13:14]
    mask = xx * xx + yy * yy <= 11 * 11
    blended = (
        source_weight * source_patch + (1.0 - source_weight) * target_patch
    ).astype(np.uint8)
    target_patch[mask] = blended[mask]


def synthetic_state_cases() -> Iterable[Tuple[str, np.ndarray, List[Set[str]], bool]]:
    truth = TRUTHS["random.jpg"]
    raw = cv2.imread(str(REAL_SCANS / "random.jpg"), cv2.IMREAD_GRAYSCALE)
    # This private localization is only used to create controlled canonical
    # state fixtures; the generated fixture is later scanned from scratch.
    canonical, _ = omr._locate_and_warp(raw, allow_clipped=True)
    circles, _, _ = omr._find_bubble_candidates(canonical)
    centers, _ = omr._fit_answer_grid(circles)
    blank_donor = {
        lane: next(
            row for row, answer in enumerate(truth) if omr.CHOICES.index(answer) != lane
        )
        for lane in range(4)
    }
    mark_donor = {
        lane: next(
            row for row, answer in enumerate(truth) if omr.CHOICES.index(answer) == lane
        )
        for lane in range(4)
    }

    blank_image = canonical.copy()
    blank_expected = expected_sets(truth)
    for row in (0, 9, 25, 49):
        lane = omr.CHOICES.index(truth[row])
        bubble_copy(
            blank_image, canonical, centers, row, lane, blank_donor[lane], lane
        )
        blank_expected[row] = set()
    yield "explicit_blank_rows", blank_image, blank_expected, True

    multiple_image = canonical.copy()
    multiple_expected = expected_sets(truth)
    for row in (1, 12, 30):
        first = omr.CHOICES.index(truth[row])
        second = (first + 2) % 4
        bubble_copy(
            multiple_image, canonical, centers, row, second, mark_donor[second], second
        )
        multiple_expected[row] = {truth[row], omr.CHOICES[second]}
    yield "explicit_multiple_rows", multiple_image, multiple_expected, True

    faint_double_image = canonical.copy()
    faint_double_expected = expected_sets(truth)
    faint_double_row = 5  # Q6 is D in the labeled mixed-answer capture.
    faint_double_lane = 0  # Add a deliberately faint A alongside the D.
    bubble_copy(
        faint_double_image,
        canonical,
        centers,
        faint_double_row,
        faint_double_lane,
        mark_donor[faint_double_lane],
        faint_double_lane,
        source_weight=0.20,
    )
    faint_double_expected[faint_double_row].add(omr.CHOICES[faint_double_lane])
    # A weak second mark must never be collapsed into a confident single
    # answer by the CNN. Preserve both candidates and reject the grade.
    yield (
        "faint_second_mark_rejection",
        faint_double_image,
        faint_double_expected,
        False,
    )

    faint_image = canonical.copy()
    faint_expected = expected_sets(truth)
    for row in (2, 17, 36):
        lane = omr.CHOICES.index(truth[row])
        bubble_copy(
            faint_image,
            canonical,
            centers,
            row,
            lane,
            blank_donor[lane],
            lane,
            source_weight=0.45,
        )
    yield "moderately_faint_marks", faint_image, faint_expected, True

    borderline_image = canonical.copy()
    borderline_expected = expected_sets(truth)
    for row in (2, 17, 36):
        lane = omr.CHOICES.index(truth[row])
        bubble_copy(
            borderline_image,
            canonical,
            centers,
            row,
            lane,
            blank_donor[lane],
            lane,
            source_weight=0.65,
        )
    # At this intensity the correct behavior is abstention, not a guessed
    # grade. It is reported separately from accepted accuracy.
    yield "borderline_faint_rejection", borderline_image, borderline_expected, False


def ratio(numerator: int, denominator: int) -> float:
    return 100.0 * numerator / denominator if denominator else 0.0


def percentile(values: Sequence[float], value: float) -> float:
    return float(np.percentile(np.asarray(values, dtype=np.float64), value))


def _is_gradeable(result: Dict[str, object]) -> bool:
    return (
        result.get("success") is True
        and int(result.get("uncertainRows", 0) or 0) == 0
        and result.get("geometryVerified") is True
    )


def _failure_stage(result: Dict[str, object]) -> object:
    if result.get("failureStage"):
        return result.get("failureStage")
    if result.get("success") is not True and result.get("stage"):
        return result.get("stage")
    details = result.get("details")
    if isinstance(details, dict) and details.get("stage"):
        return details.get("stage")
    diagnostics = result.get("diagnostics")
    if isinstance(diagnostics, dict) and diagnostics.get("failureStage"):
        return diagnostics.get("failureStage")
    if result.get("success") is True:
        if result.get("geometryVerified") is not True:
            return "geometry-verification"
        if int(result.get("uncertainRows", 0) or 0) > 0:
            return "bubble-classification"
    return None


@contextmanager
def _patched_attributes(target: object, **replacements: object) -> Iterator[None]:
    """Temporarily replace attributes without leaking benchmark test doubles."""

    previous = {
        name: getattr(target, name)
        for name in replacements
    }
    try:
        for name, replacement in replacements.items():
            setattr(target, name, replacement)
        yield
    finally:
        for name, value in previous.items():
            setattr(target, name, value)


@contextmanager
def _preserved_tracking_cache() -> Iterator[None]:
    """Give an invariant an isolated tracking cache and restore insertion order."""

    saved_items = list(omr._TRACKING_CACHE.items())
    omr._TRACKING_CACHE.clear()
    try:
        yield
    finally:
        omr._TRACKING_CACHE.clear()
        omr._TRACKING_CACHE.update(saved_items)


def _invariant_candidate(
    locator: str,
    confidence: float,
) -> Tuple[np.ndarray, Dict[str, object]]:
    placement: Dict[str, object] = {
        "detected": True,
        # Deliberately true even immediately below the threshold. The scanner
        # must enforce the numeric contract itself instead of trusting a stale
        # producer-side boolean.
        "acceptable": True,
        "confidence": confidence,
        "registrationConfidence": confidence,
        "locator": locator,
        "outlineRequired": False,
        "canonicalSize": [omr.CANONICAL_WIDTH, omr.CANONICAL_HEIGHT],
        "perspectiveTransform": np.eye(3, dtype=np.float64).tolist(),
    }
    if locator == "temporal-lk-usac":
        placement.update({
            "trackingConfidence": confidence,
            "trackingInliers": 40,
        })
    return np.full((32, 32), 255, dtype=np.uint8), placement


def _successful_evaluation_fixture(
    warped: np.ndarray,
    _tolerances: Dict[str, float],
    _placement: Dict[str, object] | None = None,
) -> Tuple[np.ndarray, np.ndarray, Dict[str, object], np.ndarray, Dict[str, object]]:
    centers = np.zeros((50, 4, 2), dtype=np.float32)
    return (
        np.empty((0, 3), dtype=np.float32),
        np.zeros((1, 1), dtype=np.uint8),
        {"method": "registration-invariant-fixture"},
        centers,
        {
            "method": "registration-invariant-fixture",
            "confidence": 99.0,
            "requiredConfidence": 60.0,
            "cellSupport": 200,
            "rowSupport": 50,
            "recoveredCells": 0,
            "bubbleLocalizationConfidence": 99.0,
            "blocks": [],
        },
    )


def _successful_classification_fixture(*_args: object, **_kwargs: object) -> Dict[str, object]:
    return {
        "answers": ["A"] * 50,
        "markedLetters": [["A"] for _ in range(50)],
        "rowStates": ["single"] * 50,
        "confidenceScores": [99.0] * 50,
        "blankRows": 0,
        "multipleRows": 0,
        "uncertainRows": 0,
        "markedRows": 50,
        "uncertainRowNumbers": [],
        "featureClustering": {},
        "aiVerification": {
            "available": False,
            "checkedRows": 0,
            "resolvedRows": 0,
        },
        "rowDiagnostics": [],
    }


def _registration_scan_patches() -> Dict[str, object]:
    """Stubs only post-registration work so routing can be tested cheaply."""

    return {
        "_evaluate_registered_sheet": _successful_evaluation_fixture,
        "_draw_candidates_only": lambda warped, *_args: warped,
        "_draw_expected_template": lambda warped, *_args: warped,
        "_draw_fitted_template": lambda warped, *_args: warped,
        "_draw_grid_debug": lambda warped, *_args: warped,
        "_draw_localization_heatmap": lambda warped, *_args: warped,
        "_extract_features": lambda *_args: (
            np.zeros((50, 4), dtype=np.float32),
            np.zeros((50, 4), dtype=np.float32),
            np.zeros((50, 4), dtype=np.float32),
            np.zeros((50, 4), dtype=np.float32),
            [],
        ),
        "_classify_rows": _successful_classification_fixture,
        "_update_tracking_cache": lambda *_args, **_kwargs: None,
        "_perceptual_header_hash": lambda *_args: "invariant-fixture",
    }


def _unavailable_registration(*_args: object, **_kwargs: object) -> Any:
    raise omr.OmrRejected(
        "Registration route intentionally unavailable in invariant fixture",
        {"stage": "template-registration"},
    )


def _confidence_boundary_invariant() -> Dict[str, object]:
    payload = encode(np.full((64, 64), 255, dtype=np.uint8))
    routes = (
        ("sift-static-template-usac", 48.0),
        ("temporal-lk-usac", 52.0),
        ("otsu-paper-contour", 65.0),
    )
    cases: List[Dict[str, object]] = []

    for locator, minimum in routes:
        route_results = []
        for confidence, expected_to_proceed in (
            (minimum - 0.01, False),
            (minimum, True),
        ):
            validation_calls = 0

            def evaluate(*args: object, **kwargs: object):
                nonlocal validation_calls
                validation_calls += 1
                return _successful_evaluation_fixture(*args, **kwargs)

            tracked = (
                (lambda *_args, c=confidence, l=locator: _invariant_candidate(l, c))
                if locator == "temporal-lk-usac"
                else (lambda *_args: None)
            )
            locate = (
                (lambda *_args, c=confidence, l=locator: _invariant_candidate(l, c))
                if locator == "otsu-paper-contour"
                else _unavailable_registration
            )
            features = (
                (
                    lambda *_args, c=confidence, l=locator:
                    [_invariant_candidate(l, c)]
                )
                if locator == "sift-static-template-usac"
                else _unavailable_registration
            )
            patches = {
                **_registration_scan_patches(),
                "_try_tracked_registration": tracked,
                "_locate_and_warp": locate,
                "_feature_registration_candidates": features,
                "_evaluate_registered_sheet": evaluate,
            }
            with _patched_attributes(omr, **patches):
                result = omr.scan_image(
                    payload,
                    {"useCnn": False, "includeDiagnostics": False},
                )
            proceeded = validation_calls > 0
            route_results.append({
                "confidence": confidence,
                "expectedToProceed": expected_to_proceed,
                "proceeded": proceeded,
                "gradeable": _is_gradeable(result),
            })
        cases.append({
            "locator": locator,
            "minimum": minimum,
            "belowRejected": (
                route_results[0]["proceeded"] is False
                and route_results[0]["gradeable"] is False
            ),
            "boundaryProceeded": (
                route_results[1]["proceeded"] is True
                and route_results[1]["gradeable"] is True
            ),
        })

    return {
        "passed": all(
            case["belowRejected"] and case["boundaryProceeded"]
            for case in cases
        ),
        "cases": cases,
    }


def _tracking_short_circuit_invariant() -> Dict[str, object]:
    calls = {"contour": 0, "feature": 0}

    def contour(*_args: object, **_kwargs: object) -> Any:
        calls["contour"] += 1
        raise AssertionError("Contour registration ran after successful tracking")

    def feature(*_args: object, **_kwargs: object) -> Any:
        calls["feature"] += 1
        raise AssertionError("Feature registration ran after successful tracking")

    patches = {
        **_registration_scan_patches(),
        "_try_tracked_registration": lambda *_args: _invariant_candidate(
            "temporal-lk-usac", 52.0
        ),
        "_locate_and_warp": contour,
        "_feature_registration_candidates": feature,
    }
    with _patched_attributes(omr, **patches):
        result = omr.scan_image(
            encode(np.full((64, 64), 255, dtype=np.uint8)),
            {"useCnn": False, "trackingSessionId": "invariant", "frameId": 2},
        )
    return {
        "passed": _is_gradeable(result) and calls == {"contour": 0, "feature": 0},
        "trackedGradeable": _is_gradeable(result),
        "fallbackCalls": calls,
    }


def _tracking_monotonicity_invariant() -> Dict[str, object]:
    key = "registration-invariant-monotonicity"
    gray = np.full((80, 60), 210, dtype=np.uint8)
    flow_calls = 0

    def optical_flow(*_args: object, **_kwargs: object) -> Any:
        nonlocal flow_calls
        flow_calls += 1
        raise AssertionError("Stale tracking state reached optical flow")

    with _preserved_tracking_cache():
        entry = {
            "updatedAt": time.monotonic(),
            "frameId": 10,
            "sourceShape": tuple(gray.shape),
            "sentinel": "newest-state",
        }
        omr._TRACKING_CACHE[key] = entry
        placement = {
            "perspectiveTransform": np.eye(3, dtype=np.float64).tolist(),
        }
        omr._update_tracking_cache(
            gray, {"trackingSessionId": key, "frameId": 9}, placement
        )
        stale_preserved = omr._TRACKING_CACHE.get(key) is entry
        omr._update_tracking_cache(
            gray, {"trackingSessionId": key, "frameId": 10}, placement
        )
        equal_preserved = omr._TRACKING_CACHE.get(key) is entry
        with _patched_attributes(
            cv2, calcOpticalFlowPyrLK=optical_flow
        ):
            stale_reused = omr._try_tracked_registration(
                gray, {"trackingSessionId": key, "frameId": 9}
            )
            equal_reused = omr._try_tracked_registration(
                gray, {"trackingSessionId": key, "frameId": 10}
            )

    return {
        "passed": (
            stale_preserved
            and equal_preserved
            and stale_reused is None
            and equal_reused is None
            and flow_calls == 0
        ),
        "staleOverwriteBlocked": stale_preserved,
        "equalOverwriteBlocked": equal_preserved,
        "staleReuseBlocked": stale_reused is None,
        "equalReuseBlocked": equal_reused is None,
    }


def _serialized_template_centers_invariant() -> Dict[str, object]:
    manifest = json.loads(
        omr.REGISTRATION_MANIFEST_PATH.read_text(encoding="utf-8")
    )
    serialized = {
        str(item.get("id") or f"reference-{index + 1}"): np.asarray(
            item.get("centers") or [], dtype=np.float32
        ).reshape(50, 4, 2)
        for index, item in enumerate(manifest.get("templates") or [])
    }
    previous_templates = omr._REGISTRATION_TEMPLATES
    previous_error = omr._REGISTRATION_TEMPLATE_ERROR
    try:
        omr._REGISTRATION_TEMPLATES = None
        omr._REGISTRATION_TEMPLATE_ERROR = None
        loaded = omr._load_registration_templates()
    finally:
        omr._REGISTRATION_TEMPLATES = previous_templates
        omr._REGISTRATION_TEMPLATE_ERROR = previous_error

    loaded_by_id = {str(item["id"]): item for item in loaded}
    exact_ids = [
        template_id
        for template_id, expected in serialized.items()
        if template_id in loaded_by_id
        and np.array_equal(
            np.asarray(loaded_by_id[template_id]["centers"], dtype=np.float32),
            expected,
        )
    ]
    nominal = np.asarray(
        [
            [
                [
                    relative_x * omr.CANONICAL_WIDTH,
                    (
                        omr.NOMINAL_TOP_Y
                        + row * omr.NOMINAL_ROW_SPACING
                    )
                    * omr.CANONICAL_HEIGHT,
                ]
                for relative_x in relative_xs
            ]
            for relative_xs in (omr.NOMINAL_LEFT_X, omr.NOMINAL_RIGHT_X)
            for row in range(25)
        ],
        dtype=np.float32,
    )
    max_nominal_deviation = max(
        (
            float(np.max(np.abs(centers - nominal)))
            for centers in serialized.values()
        ),
        default=0.0,
    )
    return {
        "passed": (
            bool(serialized)
            and len(exact_ids) == len(serialized)
            and len(loaded_by_id) == len(serialized)
            and max_nominal_deviation > 0.5
        ),
        "serializedTemplates": len(serialized),
        "exactlyLoadedTemplates": len(exact_ids),
        "maxNominalDeviationPixels": round(max_nominal_deviation, 3),
    }


def _static_tracking_mask_invariant() -> Dict[str, object]:
    templates = omr._load_registration_templates()
    template = next(
        (item for item in templates if item.get("primary")),
        templates[0] if templates else None,
    )
    if template is None:
        raise RuntimeError("No registration template is available")
    gray = np.asarray(template["image"], dtype=np.uint8)
    key = "registration-invariant-static-mask"
    placement = {
        "perspectiveTransform": np.eye(3, dtype=np.float64).tolist(),
        "templateId": template["id"],
    }
    with _preserved_tracking_cache():
        omr._update_tracking_cache(
            gray,
            {"trackingSessionId": key, "frameId": 1},
            placement,
        )
        entry = omr._TRACKING_CACHE.get(key)
        if entry is None:
            raise RuntimeError("Static-mask fixture produced no tracking points")
        points = np.asarray(entry["points"], dtype=np.float32).reshape(-1, 2)
        scale = float(entry["smallScale"])
        canonical_to_small = np.asarray(
            [[scale, 0.0, 0.0], [0.0, scale, 0.0], [0.0, 0.0, 1.0]],
            dtype=np.float64,
        )
        projected_mask = cv2.warpPerspective(
            omr._registration_static_mask(
                (omr.CANONICAL_HEIGHT, omr.CANONICAL_WIDTH)
            ),
            canonical_to_small,
            (entry["small"].shape[1], entry["small"].shape[0]),
            flags=cv2.INTER_NEAREST,
            borderMode=cv2.BORDER_CONSTANT,
            borderValue=0,
        )
        point_pixels = np.rint(points).astype(np.int32)
        point_pixels[:, 0] = np.clip(
            point_pixels[:, 0], 0, projected_mask.shape[1] - 1
        )
        point_pixels[:, 1] = np.clip(
            point_pixels[:, 1], 0, projected_mask.shape[0] - 1
        )
        point_values = projected_mask[
            point_pixels[:, 1], point_pixels[:, 0]
        ]
        projected_centers = (
            np.asarray(template["centers"], dtype=np.float32).reshape(-1, 2)
            * scale
        )
        center_pixels = np.rint(projected_centers).astype(np.int32)
        center_values = projected_mask[
            center_pixels[:, 1], center_pixels[:, 0]
        ]
        nearest_dynamic_distance = float(
            np.min(
                np.linalg.norm(
                    points[:, None, :] - projected_centers[None, :, :],
                    axis=2,
                )
            )
        )
        dynamic_exclusion_radius = 17.0 * scale

    return {
        "passed": (
            len(points) >= 24
            and bool(np.all(point_values > 0))
            and bool(np.all(center_values == 0))
            and nearest_dynamic_distance > dynamic_exclusion_radius
        ),
        "selectedStaticPoints": len(points),
        "pointsOutsideStaticMask": int(np.count_nonzero(point_values == 0)),
        "answerCentersInsideStaticMask": int(
            np.count_nonzero(center_values > 0)
        ),
        "nearestAnswerCenterDistancePixels": round(
            nearest_dynamic_distance, 3
        ),
        "dynamicExclusionRadiusPixels": round(
            dynamic_exclusion_radius, 3
        ),
    }


def _row_phase_identity_invariant() -> Dict[str, object]:
    templates = omr._load_registration_templates()
    template = next(
        (item for item in templates if item.get("primary")),
        templates[0] if templates else None,
    )
    if template is None:
        raise RuntimeError("No registration template is available")
    serialized_centers = np.asarray(
        template["centers"], dtype=np.float32
    ).reshape(50, 4, 2)
    registered_start = float(
        np.mean(serialized_centers[[0, 25], :, 1])
    )
    circles = np.asarray(
        [
            [float(x), float(y), 13.0]
            for row in range(50)
            if row not in (0, 25)
            for x, y in serialized_centers[row]
        ],
        dtype=np.float32,
    )
    registration = {
        "locator": "sift-static-template-usac",
        "templateRowStart": registered_start,
        "registrationConfidence": 90.0,
        "featureConfidence": 90.0,
        "inliers": 50,
        "templateYSpan": 1500.0,
        "medianReprojectionError": 0.5,
        "leftStaticSupport": 20,
        "rightStaticSupport": 20,
        "questionsOutsideFrame": [],
    }
    spacing = float(
        np.median(
            np.diff(
                serialized_centers[:25, :, 1].mean(axis=1)
            )
        )
    )
    try:
        fitted, geometry = omr._fit_answer_grid(
            circles, registration=registration
        )
    except omr.OmrRejected as error:
        return {
            "passed": True,
            "outcome": "fail-closed",
            "failureStage": error.details.get("stage"),
        }
    fitted_start = float(np.mean(fitted[[0, 25], :, 1]))
    phase_error_rows = abs(fitted_start - registered_start) / max(
        1.0, spacing
    )
    return {
        "passed": (
            geometry.get("absoluteRowPhaseAnchored") is True
            and phase_error_rows <= 0.25
        ),
        "outcome": "recovered",
        "phaseAdjustmentRows": geometry.get("rowPhaseAdjustment"),
        "phaseErrorRows": round(phase_error_rows, 4),
        "absoluteRowPhaseAnchored": geometry.get(
            "absoluteRowPhaseAnchored"
        ),
    }


def run_registration_invariants() -> Dict[str, object]:
    checks: Dict[str, Callable[[], Dict[str, object]]] = {
        "confidenceBoundaries": _confidence_boundary_invariant,
        "trackingShortCircuit": _tracking_short_circuit_invariant,
        "trackingFrameMonotonicity": _tracking_monotonicity_invariant,
        "serializedTemplateCenters": _serialized_template_centers_invariant,
        "staticTrackingMask": _static_tracking_mask_invariant,
        "rowPhaseIdentity": _row_phase_identity_invariant,
    }
    results: Dict[str, Dict[str, object]] = {}
    for name, check in checks.items():
        try:
            results[name] = check()
        except Exception as error:
            results[name] = {
                "passed": False,
                "error": f"{type(error).__name__}: {error}",
            }
    return {
        "passed": all(result.get("passed") is True for result in results.values()),
        "checks": results,
    }


def run_partial_document_benchmark(
    source_names: Sequence[str] | None = None,
) -> Dict[str, object]:
    """Exercise border-independent registration separately from normal scans."""

    selected = list(source_names or TRUTHS.keys())
    unknown = [name for name in selected if name not in TRUTHS]
    if unknown:
        raise ValueError(f"Unknown partial-document sources: {unknown}")

    valid_results: List[Dict[str, object]] = []
    negative_results: List[Dict[str, object]] = []
    timings: List[float] = []
    exact_rows = 0
    gradeable_sheets = 0
    exact_sheets = 0

    for filename in selected:
        image = cv2.imread(str(REAL_SCANS / filename))
        if image is None:
            raise RuntimeError(f"Could not read trusted source {filename}")
        valid_cases, negative_cases = partial_document_variants(image)
        truth = TRUTHS[filename]
        for case in valid_cases:
            try:
                result = omr.scan_image(
                    encode(case["image"]),
                    {"useCnn": True, "includeDiagnostics": False},
                )
            except Exception as error:
                result = {
                    "success": False,
                    "reason": f"Benchmark scanner exception: {error}",
                    "failureStage": "benchmark-exception",
                }
            processing_ms = float(result.get("processingMs", 0.0) or 0.0)
            timings.append(processing_ms)
            gradeable = _is_gradeable(result)
            predicted = result.get("markedLetters") or []
            exact = update_confusion(
                {"tp": 0, "tn": 0, "fp": 0, "fn": 0},
                expected_sets(truth),
                predicted,
            )
            mismatched_questions = [
                int(index + 1)
                for index in range(50)
                if (
                    set(predicted[index])
                    if index < len(predicted)
                    else set()
                )
                != {truth[index]}
            ]
            exact_rows += exact
            if gradeable:
                gradeable_sheets += 1
            if gradeable and exact == 50:
                exact_sheets += 1
            placement = result.get("placement")
            if not isinstance(placement, dict):
                placement = {}
            valid_results.append(
                {
                    "sheet": filename,
                    "variant": case["name"],
                    "condition": case["condition"],
                    "expectedGradeable": True,
                    "allAnswerPatchesVisible": not bool(
                        case["questionsOutsideFrame"]
                    ),
                    "visibleBubblePatchFraction": round(
                        float(case["visibleBubblePatchFraction"]), 4
                    ),
                    "questionsOutsideFrame": case["questionsOutsideFrame"],
                    "gradeable": gradeable,
                    "exactRows": exact,
                    "mismatchedQuestions": mismatched_questions,
                    "success": result.get("success"),
                    "geometryVerified": result.get("geometryVerified"),
                    "uncertainRows": result.get("uncertainRows"),
                    "blankRows": result.get("blankRows"),
                    "multipleRows": result.get("multipleRows"),
                    "processingMs": result.get("processingMs"),
                    "registrationConfidence": result.get(
                        "registrationConfidence",
                        placement.get("registrationConfidence"),
                    ),
                    "bubbleLocalizationConfidence": result.get(
                        "bubbleLocalizationConfidence"
                    ),
                    "failureStage": _failure_stage(result),
                    "reason": result.get("reason"),
                }
            )

        for case in negative_cases:
            try:
                result = omr.scan_image(
                    encode(case["image"]),
                    {"useCnn": True, "includeDiagnostics": False},
                )
            except Exception as error:
                result = {
                    "success": False,
                    "reason": f"Benchmark scanner exception: {error}",
                    "failureStage": "benchmark-exception",
                }
            processing_ms = float(result.get("processingMs", 0.0) or 0.0)
            timings.append(processing_ms)
            gradeable = _is_gradeable(result)
            negative_results.append(
                {
                    "sheet": filename,
                    "variant": case["name"],
                    "condition": case["condition"],
                    "expectedGradeable": False,
                    "allAnswerPatchesVisible": False,
                    "visibleBubblePatchFraction": round(
                        float(case["visibleBubblePatchFraction"]), 4
                    ),
                    "questionsOutsideFrame": case["questionsOutsideFrame"],
                    "gradeable": gradeable,
                    "safelyRejected": not gradeable,
                    "success": result.get("success"),
                    "geometryVerified": result.get("geometryVerified"),
                    "uncertainRows": result.get("uncertainRows"),
                    "processingMs": result.get("processingMs"),
                    "failureStage": _failure_stage(result),
                    "reason": result.get("reason"),
                }
            )

        # Release all large 4K variants before preparing the next source.
        del valid_cases, negative_cases, image

    valid_count = len(valid_results)
    negative_count = len(negative_results)
    safely_rejected = sum(
        1 for case in negative_results if case["safelyRejected"]
    )
    conditions = {
        "trustedSourceCaptures": len(selected),
        "validVariantSheets": valid_count,
        "validQuestions": valid_count * 50,
        "allValidAnswerPatchesVisible": all(
            bool(case["allAnswerPatchesVisible"]) for case in valid_results
        ),
        "validQuestionAccuracyPercent": round(
            ratio(exact_rows, valid_count * 50), 4
        ),
        "validExactSheetRatePercent": round(
            ratio(exact_sheets, valid_count), 4
        ),
        "validGradeableSheetRatePercent": round(
            ratio(gradeable_sheets, valid_count), 4
        ),
        "negativeControlSheets": negative_count,
        "negativeControlsSafelyRejectedPercent": round(
            ratio(safely_rejected, negative_count), 4
        ),
        "confidentNegativeMisgrades": negative_count - safely_rejected,
        "averageProcessingMs": (
            round(statistics.mean(timings), 3) if timings else 0.0
        ),
        "p95ProcessingMs": (
            round(percentile(timings, 95), 3) if timings else 0.0
        ),
        "maxProcessingMs": round(max(timings), 3) if timings else 0.0,
    }
    return {
        "conditions": conditions,
        "cases": valid_results,
        "negativeControls": negative_results,
        "timings": timings,
    }


def _read_exact(stream, length: int) -> bytes:
    chunks = bytearray()
    while len(chunks) < length:
        chunk = stream.read(length - len(chunks))
        if not chunk:
            raise RuntimeError("Persistent worker closed its output")
        chunks.extend(chunk)
    return bytes(chunks)


def measure_persistent_worker() -> Dict[str, object]:
    """Measure the deployed process boundary, including cold start and CNN RSS."""

    try:
        import psutil
    except Exception:
        return {"available": False, "reason": "psutil is not installed"}

    child = subprocess.Popen(
        [sys.executable, str(ROOT / "ml-training" / "fast_omr_worker.py"), "--worker"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    process = psutil.Process(child.pid)
    peak_rss = 0
    stop_monitor = threading.Event()

    def monitor() -> None:
        nonlocal peak_rss
        while not stop_monitor.wait(0.005):
            try:
                peak_rss = max(peak_rss, process.memory_info().rss)
            except Exception:
                return

    monitor_thread = threading.Thread(target=monitor, daemon=True)
    monitor_thread.start()
    wall_times = []
    responses = []

    def request(image_bytes: bytes, request_id: int) -> Dict[str, object]:
        header = json.dumps(
            {"id": str(request_id), "useCnn": True},
            separators=(",", ":"),
        ).encode("utf-8")
        frame = (
            struct.pack(">I", len(header))
            + header
            + struct.pack(">I", len(image_bytes))
            + image_bytes
        )
        started = time.perf_counter()
        child.stdin.write(frame)
        child.stdin.flush()
        response_length = struct.unpack(">I", _read_exact(child.stdout, 4))[0]
        response = json.loads(_read_exact(child.stdout, response_length))
        wall_times.append((time.perf_counter() - started) * 1000.0)
        responses.append(response)
        return response

    try:
        cpu_before = process.cpu_times()
        for index, filename in enumerate(TRUTHS):
            request((REAL_SCANS / filename).read_bytes(), index)
        rss_after_normal = process.memory_info().rss

        borderline = next(
            image
            for name, image, _, _ in synthetic_state_cases()
            if name == "borderline_faint_rejection"
        )
        cnn_result = request(encode(borderline, quality=92), 99)
        rss_after_cnn = process.memory_info().rss
        cpu_after = process.cpu_times()
        cpu_seconds = (
            cpu_after.user
            + cpu_after.system
            - cpu_before.user
            - cpu_before.system
        )
        return {
            "available": True,
            "coldWallMs": round(wall_times[0], 3),
            "warmAverageWallMs": round(statistics.mean(wall_times[1:5]), 3),
            "warmP95WallMs": round(percentile(wall_times[1:5], 95), 3),
            "ambiguousCnnWallMs": round(wall_times[-1], 3),
            "workerCpuSeconds": round(cpu_seconds, 3),
            "workerPeakRssMiB": round(peak_rss / (1024 * 1024), 3),
            "workerRssAfterNormalMiB": round(rss_after_normal / (1024 * 1024), 3),
            "workerRssAfterCnnMiB": round(rss_after_cnn / (1024 * 1024), 3),
            "allOriginalsCorrect": all(
                response.get("answers") == list(TRUTHS[filename])
                for response, filename in zip(responses[:5], TRUTHS)
            ),
            "cnnCheckedRows": (
                cnn_result.get("aiVerification") or {}
            ).get("checkedRows", 0),
        }
    finally:
        stop_monitor.set()
        monitor_thread.join(timeout=1)
        child.terminate()
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()


def run_benchmark(quick: bool = False) -> Dict[str, object]:
    registration_invariants = run_registration_invariants()
    try:
        import psutil

        process = psutil.Process(os.getpid())
        rss_before = process.memory_info().rss
    except Exception:
        process = None
        rss_before = 0
    peak_rss = rss_before
    wall_started = time.perf_counter()
    cpu_started = time.process_time()

    normal_confusion = {"tp": 0, "tn": 0, "fp": 0, "fn": 0}
    normal_rows = 0
    normal_exact_sheets = 0
    normal_gradeable_sheets = 0
    normal_results = []
    timings: List[float] = []

    for filename, truth in TRUTHS.items():
        image = cv2.imread(str(REAL_SCANS / filename))
        # Keep only one transformed 4K frame alive at a time; otherwise the
        # benchmark itself (not the worker) retains ~200 MiB of variant arrays.
        variants = [("original", image)] if quick else normal_variants(image)
        for variant_name, variant in variants:
            result = omr.scan_image(encode(variant), {"useCnn": True})
            timings.append(float(result.get("processingMs", 0.0)))
            gradeable = (
                result.get("success") is True
                and int(result.get("uncertainRows", 0)) == 0
                and result.get("geometryVerified") is True
            )
            if gradeable:
                normal_gradeable_sheets += 1
            predicted = result.get("markedLetters") or []
            exact = update_confusion(
                normal_confusion, expected_sets(truth), predicted
            )
            normal_rows += exact
            if gradeable and exact == 50:
                normal_exact_sheets += 1
            normal_results.append(
                {
                    "sheet": filename,
                    "variant": variant_name,
                    "gradeable": gradeable,
                    "exactRows": exact,
                    "processingMs": result.get("processingMs"),
                    "reason": result.get("reason"),
                }
            )
            if process is not None:
                peak_rss = max(peak_rss, process.memory_info().rss)

    state_results = []
    if not quick:
        for name, image, expected, should_grade in synthetic_state_cases():
            result = omr.scan_image(
                encode(image, quality=92),
                {"useCnn": True, "includeDiagnostics": False},
            )
            gradeable = (
                result.get("success") is True
                and int(result.get("uncertainRows", 0)) == 0
                and result.get("geometryVerified") is True
            )
            exact = update_confusion(
                {"tp": 0, "tn": 0, "fp": 0, "fn": 0},
                expected,
                result.get("markedLetters") or [],
            )
            state_results.append(
                {
                    "case": name,
                    "expectedGradeable": should_grade,
                    "gradeable": gradeable,
                    "exactRows": exact,
                    "blankRows": result.get("blankRows"),
                    "multipleRows": result.get("multipleRows"),
                    "uncertainRows": result.get("uncertainRows"),
                    "aiVerification": result.get("aiVerification"),
                    "processingMs": result.get("processingMs"),
                }
            )
            timings.append(float(result.get("processingMs", 0.0)))
            if process is not None:
                peak_rss = max(peak_rss, process.memory_info().rss)

    if quick:
        partial_document = {
            "conditions": {
                "skipped": True,
                "reason": "Use --partial-only for the focused partial-document suite",
            },
            "cases": [],
            "negativeControls": [],
            "timings": [],
        }
    else:
        partial_document = run_partial_document_benchmark()
        timings.extend(
            float(value) for value in partial_document.get("timings", [])
        )
        if process is not None:
            peak_rss = max(peak_rss, process.memory_info().rss)

    wall_seconds = time.perf_counter() - wall_started
    cpu_seconds = time.process_time() - cpu_started
    tp = normal_confusion["tp"]
    tn = normal_confusion["tn"]
    fp = normal_confusion["fp"]
    fn = normal_confusion["fn"]
    total_bubbles = tp + tn + fp + fn
    normal_sheet_count = len(normal_results)
    deployed_worker = measure_persistent_worker()

    return {
        "dataset": {
            "physicalSourceCaptures": len(TRUTHS),
            "normalVariantSheets": normal_sheet_count,
            "normalQuestions": normal_sheet_count * 50,
            "normalBubblePositions": total_bubbles,
            "variants": sorted({item["variant"] for item in normal_results}),
            "partialDocumentVariantSheets": len(
                partial_document.get("cases", [])
            ),
            "partialDocumentNegativeControls": len(
                partial_document.get("negativeControls", [])
            ),
        },
        "normalConditions": {
            "questionAccuracyPercent": round(
                ratio(normal_rows, normal_sheet_count * 50), 4
            ),
            "exactSheetRatePercent": round(
                ratio(normal_exact_sheets, normal_sheet_count), 4
            ),
            "gradeableSheetRatePercent": round(
                ratio(normal_gradeable_sheets, normal_sheet_count), 4
            ),
            "bubbleAccuracyPercent": round(ratio(tp + tn, total_bubbles), 4),
            "precisionPercent": round(ratio(tp, tp + fp), 4),
            "recallPercent": round(ratio(tp, tp + fn), 4),
            "falsePositiveRatePercent": round(ratio(fp, fp + tn), 4),
            "falseNegativeRatePercent": round(ratio(fn, fn + tp), 4),
            "confusion": normal_confusion,
        },
        "stateCases": state_results,
        "partialDocumentConditions": partial_document["conditions"],
        "partialDocumentCases": partial_document["cases"],
        "partialDocumentNegativeControls": partial_document[
            "negativeControls"
        ],
        "registrationInvariants": registration_invariants,
        "performance": {
            "averageProcessingMs": round(statistics.mean(timings), 3),
            "medianProcessingMs": round(percentile(timings, 50), 3),
            "p95ProcessingMs": round(percentile(timings, 95), 3),
            "maxProcessingMs": round(max(timings), 3),
            "cpuSeconds": round(cpu_seconds, 3),
            "wallSeconds": round(wall_seconds, 3),
            "averageCpuUtilizationPercent": round(
                100.0 * cpu_seconds / max(1e-9, wall_seconds), 2
            ),
            "rssBeforeMiB": round(rss_before / (1024 * 1024), 3),
            "peakRssMiB": round(peak_rss / (1024 * 1024), 3),
            "peakRssIncreaseMiB": round(
                max(0, peak_rss - rss_before) / (1024 * 1024), 3
            ),
            "rssNote": "In-process benchmark RSS includes original/transformed test images; deployed worker measurement is below.",
            "persistentWorker": deployed_worker,
        },
        "cases": normal_results,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--quick", action="store_true", help="Run only the five original captures"
    )
    parser.add_argument(
        "--partial-only",
        action="store_true",
        help=(
            "Run only partial-document registration cases; combine with "
            "--quick to use random.jpg as a focused smoke test"
        ),
    )
    parser.add_argument(
        "--registration-invariants-only",
        action="store_true",
        help="Run only fast registration and tracking contract checks",
    )
    args = parser.parse_args()
    if args.registration_invariants_only:
        invariants = run_registration_invariants()
        print(json.dumps({"registrationInvariants": invariants}, indent=2))
        return 0 if invariants["passed"] else 1

    if args.partial_only:
        partial = run_partial_document_benchmark(
            ["random.jpg"] if args.quick else None
        )
        invariants = run_registration_invariants()
        result = {
            "partialDocumentConditions": partial["conditions"],
            "partialDocumentCases": partial["cases"],
            "partialDocumentNegativeControls": partial["negativeControls"],
            "registrationInvariants": invariants,
        }
        print(json.dumps(result, indent=2))
        conditions = partial["conditions"]
        passed = (
            conditions["allValidAnswerPatchesVisible"] is True
            and conditions["validQuestionAccuracyPercent"] >= 99.0
            and conditions["validExactSheetRatePercent"] >= 99.0
            and conditions["validGradeableSheetRatePercent"] >= 99.0
            and conditions["negativeControlsSafelyRejectedPercent"] >= 99.0
            and conditions["confidentNegativeMisgrades"] == 0
            and invariants["passed"] is True
        )
        return 0 if passed else 1

    result = run_benchmark(quick=args.quick)
    print(json.dumps(result, indent=2))

    normal = result["normalConditions"]
    performance = result["performance"]
    worker = performance["persistentWorker"]
    state_cases = {case["case"]: case for case in result["stateCases"]}
    state_checks = [True] if args.quick else [
        all(case.get("gradeable") == case.get("expectedGradeable") for case in state_cases.values()),
        all(case.get("exactRows") == 50 for case in state_cases.values()),
        state_cases["explicit_blank_rows"].get("blankRows") == 4,
        state_cases["explicit_blank_rows"].get("uncertainRows") == 0,
        state_cases["explicit_multiple_rows"].get("multipleRows") == 3,
        state_cases["explicit_multiple_rows"].get("uncertainRows") == 0,
        state_cases["faint_second_mark_rejection"].get("uncertainRows", 0) >= 1,
        state_cases["moderately_faint_marks"].get("uncertainRows") == 0,
        state_cases["borderline_faint_rejection"].get("uncertainRows", 0) >= 1,
    ]
    partial = result["partialDocumentConditions"]
    partial_checks = [True] if args.quick else [
        partial.get("allValidAnswerPatchesVisible") is True,
        partial.get("validQuestionAccuracyPercent", 0.0) >= 99.0,
        partial.get("validExactSheetRatePercent", 0.0) >= 99.0,
        partial.get("validGradeableSheetRatePercent", 0.0) >= 99.0,
        partial.get("negativeControlsSafelyRejectedPercent", 0.0) >= 99.0,
        partial.get("confidentNegativeMisgrades") == 0,
    ]
    passed = (
        normal["questionAccuracyPercent"] >= 99.0
        and normal["exactSheetRatePercent"] >= 99.0
        and normal["gradeableSheetRatePercent"] >= 99.0
        and performance["maxProcessingMs"] < 1000.0
        and worker.get("available") is True
        and worker.get("allOriginalsCorrect") is True
        and worker.get("warmAverageWallMs", float("inf")) < 1000.0
        and all(state_checks)
        and all(partial_checks)
        and result["registrationInvariants"]["passed"] is True
    )
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
