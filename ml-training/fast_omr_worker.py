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
from collections import OrderedDict
import hashlib
import json
import math
import os
import platform
import struct
import sys
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

_configured_thread_value = str(os.environ.get("OMR_OPENCV_THREADS", "")).strip()
try:
    _configured_threads = int(_configured_thread_value)
except (TypeError, ValueError):
    _configured_threads = 0
if _configured_threads > 0:
    # OpenCV and the numeric libraries otherwise size their pools from the
    # host, which can oversubscribe a one-vCPU container/Droplet. Apply the
    # explicit deployment budget before importing either native runtime.
    _configured_threads = min(32, _configured_threads)
    for _thread_variable in (
        "OMP_NUM_THREADS",
        "OPENBLAS_NUM_THREADS",
        "MKL_NUM_THREADS",
        "NUMEXPR_NUM_THREADS",
    ):
        os.environ[_thread_variable] = str(_configured_threads)

import cv2
import numpy as np

if _configured_threads > 0:
    cv2.setNumThreads(_configured_threads)

CANONICAL_WIDTH = 800
CANONICAL_HEIGHT = 2500
# Broad normalized-page search region. Printer margins, camera crop, and
# residual perspective may move the grid by several percent.
ANSWER_ROI = (
    round(CANONICAL_WIDTH * 0.04),
    round(CANONICAL_HEIGHT * 0.15),
    round(CANONICAL_WIDTH * 0.96),
    round(CANONICAL_HEIGHT * 0.93),
)
CHOICES = "ABCD"
FORM_LAYOUT = "acadcheck-50-v1"
QR_GRID_MIN_REGISTRATION_CONFIDENCE = 55.0
# Fixed physical placement of the v1 identity QR in canonical form space.
# A QR-only warp is deliberately only a seed: every accepted result must still
# recover and validate the current sheet's two 25x4 printed-ring lattices.
QR_CANONICAL_CORNERS = np.asarray(
    [
        [197.58, 2299.08],
        [337.14, 2298.32],
        [337.78, 2527.46],
        [196.03, 2523.73],
    ],
    dtype=np.float32,
)
QR_LATTICE_MIN_REGISTRATION_CONFIDENCE = 45.0
SIFT_MIN_REGISTRATION_CONFIDENCE = 45.0
REFERENCE_FRAME_MIN_REGISTRATION_CONFIDENCE = 58.0
MODEL_PATH = Path(
    os.environ.get(
        "OMR_BUBBLE_MODEL_PATH",
        Path(__file__).resolve().parents[1] / "backend" / "models" / "bubble-classifier.onnx",
    )
)
DIGIT_MODEL_PATH = Path(
    os.environ.get(
        'OMR_DIGIT_MODEL_PATH',
        Path(__file__).resolve().parents[1] / 'backend' / 'models' / 'digit-classifier.onnx',
    )
)
REGISTRATION_TEMPLATE_DIR = Path(
    os.environ.get(
        "OMR_REGISTRATION_TEMPLATE_DIR",
        Path(__file__).resolve().parent / "registration_templates" / "acadcheck-50-v1",
    )
)
REGISTRATION_MANIFEST_PATH = REGISTRATION_TEMPLATE_DIR / "manifest.json"

_INNER_Y, _INNER_X = np.ogrid[-14:15, -14:15]
_INNER_MASK = (_INNER_X * _INNER_X + _INNER_Y * _INNER_Y) <= 8 * 8
_WIDE_INNER_MASK = (_INNER_X * _INNER_X + _INNER_Y * _INNER_Y) <= 10 * 10
_CORNER_MASK = (np.abs(_INNER_X) >= 10) & (np.abs(_INNER_Y) >= 10)
_PROFILE_COORD_CACHE: Dict[int, np.ndarray] = {}
_CNN_NET = None
_CNN_LOAD_ATTEMPTED = False
_DIGIT_NET = None
_DIGIT_LOAD_ATTEMPTED = False
_REGISTRATION_TEMPLATES: Optional[List[Dict[str, Any]]] = None
_REGISTRATION_TEMPLATE_ERROR: Optional[str] = None
_REGISTRATION_STATIC_MASK_IMAGE: Optional[np.ndarray] = None
_TRACKING_CACHE: "OrderedDict[str, Dict[str, Any]]" = OrderedDict()
# Keep verified static-print tracking through finalization and normal sheet
# replacement. Every reuse still has to pass current-frame optical-flow,
# 200-cell lattice, absolute-row-phase, and image-quality gates.
_TRACKING_TTL_SECONDS = 6.0 * 60.0 * 60.0
_TRACKING_CACHE_LIMIT = 8
# Hough is the only super-linear operation in the 200-cell localization path.
# The printed rings remain 7-18 px at this scale, while the 20% reduction
# removes roughly one third of the accumulator work on a canonical frame.
_BUBBLE_HOUGH_SCALE = 0.80
NOMINAL_LEFT_X = (0.18375, 0.23125, 0.27875, 0.32625)
NOMINAL_RIGHT_X = (0.66, 0.7075, 0.755, 0.8025)
NOMINAL_TOP_Y = 0.216
NOMINAL_ROW_SPACING = 0.0264
DEFAULT_GEOMETRY_TOLERANCES = {
    # All distances are relative to the perspective-normalized page.
    "bubbleRadiusMinRatio": 0.0105,
    "bubbleRadiusMaxRatio": 0.0280,
    "choiceSpacingMinRatio": 0.030,
    "choiceSpacingMaxRatio": 0.078,
    "rowSpacingMinRatio": 0.019,
    "rowSpacingMaxRatio": 0.035,
    "assignmentXFraction": 0.36,
    "assignmentYFraction": 0.24,
    "targetCellSupport": 135.0,
    "targetRowSupport": 50.0,
    "targetLaneSupport": 12.0,
    "minimumGeometryConfidence": 42.0,
}
GEOMETRY_TOLERANCE_LIMITS = {
    "bubbleRadiusMinRatio": (0.006, 0.018),
    "bubbleRadiusMaxRatio": (0.018, 0.045),
    "choiceSpacingMinRatio": (0.018, 0.050),
    "choiceSpacingMaxRatio": (0.050, 0.110),
    "rowSpacingMinRatio": (0.012, 0.027),
    "rowSpacingMaxRatio": (0.027, 0.050),
    "assignmentXFraction": (0.20, 0.60),
    "assignmentYFraction": (0.14, 0.45),
    "targetCellSupport": (80.0, 190.0),
    "targetRowSupport": (30.0, 50.0),
    "targetLaneSupport": (5.0, 20.0),
    "minimumGeometryConfidence": (30.0, 80.0),
}


class OmrRejected(RuntimeError):
    """A readable image that cannot be graded without guessing."""

    def __init__(self, reason: str, details: Optional[Dict[str, Any]] = None):
        super().__init__(reason)
        self.reason = reason
        self.details = details or {}


def _resolve_geometry_tolerances(
    options: Optional[Dict[str, Any]] = None,
) -> Dict[str, float]:
    """Merge safe runtime overrides with the normalized-layout defaults."""
    supplied = (options or {}).get("geometryTolerances") or {}
    resolved = dict(DEFAULT_GEOMETRY_TOLERANCES)
    if not isinstance(supplied, dict):
        return resolved
    for key, (minimum, maximum) in GEOMETRY_TOLERANCE_LIMITS.items():
        try:
            value = float(supplied[key])
        except (KeyError, TypeError, ValueError):
            continue
        if math.isfinite(value):
            resolved[key] = min(maximum, max(minimum, value))
    # Keep ranges ordered even if a caller supplies opposing extrema.
    if resolved["bubbleRadiusMinRatio"] >= resolved["bubbleRadiusMaxRatio"]:
        resolved["bubbleRadiusMinRatio"] = (
            resolved["bubbleRadiusMaxRatio"] * 0.60
        )
    if resolved["choiceSpacingMinRatio"] >= resolved["choiceSpacingMaxRatio"]:
        resolved["choiceSpacingMinRatio"] = (
            resolved["choiceSpacingMaxRatio"] * 0.60
        )
    if resolved["rowSpacingMinRatio"] >= resolved["rowSpacingMaxRatio"]:
        resolved["rowSpacingMinRatio"] = (
            resolved["rowSpacingMaxRatio"] * 0.60
        )
    return resolved


def _stage_ms(start: float) -> float:
    return round((time.perf_counter() - start) * 1000.0, 3)


def _score_between(value: float, poor: float, good: float) -> float:
    """Map an observed quality value to a bounded, readable percentage."""

    if good <= poor:
        return 0.0
    return 100.0 * min(1.0, max(0.0, (value - poor) / (good - poor)))


def _uint8_percentiles(image: np.ndarray, quantiles: Sequence[float]) -> np.ndarray:
    """Exact linear percentiles from 256 bins, without partitioning a full image."""
    # calcHist reads uint8 pixels directly, avoiding the full int64 copy made
    # by bincount on every camera frame. Float32 bins are exact through 2**24;
    # retain integer counts for larger inputs rather than rounding evidence.
    histogram = (
        cv2.calcHist([image], [0], None, [256], [0, 256]).reshape(-1)
        if 0 < image.size <= 2 ** 24
        else np.bincount(image.reshape(-1), minlength=256)
    )
    counts = np.cumsum(histogram, dtype=np.int64)
    ranks = np.asarray(quantiles, dtype=np.float64) * ((image.size - 1) / 100.0)
    lower = np.floor(ranks)
    low_values = np.searchsorted(counts, lower, side="right").astype(np.float64)
    high_values = np.searchsorted(counts, np.ceil(ranks), side="right")
    return low_values + (high_values - low_values) * (ranks - lower)


def _normalize_lighting(
    warped: np.ndarray,
) -> Tuple[np.ndarray, Dict[str, Any]]:
    """Remove broad shadows/glare while preserving pencil-scale detail.

    The illumination field is estimated at one quarter resolution with a
    blur much wider than both a bubble and the printed row spacing. Division
    (rather than histogram equalization alone) corrects multiplicative camera
    shading and keeps the same mark thresholds meaningful across the page.
    """

    started = time.perf_counter()
    sample_width = max(120, CANONICAL_WIDTH // 4)
    sample_height = max(300, CANONICAL_HEIGHT // 4)
    reduced = cv2.resize(
        warped,
        (sample_width, sample_height),
        interpolation=cv2.INTER_AREA,
    )
    # Float filtering uses the separable kernel efficiently for this broad
    # illumination field. Round back to the original 8-bit background before
    # division; the source bubble pixels are never blurred.
    background_small = cv2.GaussianBlur(
        reduced.astype(np.float32),
        (0, 0),
        sigmaX=max(12.0, sample_width * 0.085),
        sigmaY=max(20.0, sample_height * 0.055),
        borderType=cv2.BORDER_REPLICATE,
    )
    background_small = np.clip(np.rint(background_small), 0, 255).astype(np.uint8)
    background = cv2.resize(
        background_small,
        (CANONICAL_WIDTH, CANONICAL_HEIGHT),
        interpolation=cv2.INTER_LINEAR,
    )
    safe_background = np.maximum(background, 32).astype(np.uint8)
    normalized = cv2.divide(warped, safe_background, scale=220.0)

    left, top, right, bottom = ANSWER_ROI
    raw_roi = warped[top:bottom, left:right]
    normalized_roi = normalized[top:bottom, left:right]
    background_roi = background[top:bottom, left:right]
    raw_p05, raw_p50, raw_p95 = (
        float(value) for value in _uint8_percentiles(raw_roi, [5, 50, 95])
    )
    bg_p10, bg_p50, bg_p90 = (
        float(value)
        for value in _uint8_percentiles(background_roi, [10, 50, 90])
    )
    normalized_p05, normalized_p95 = (
        float(value)
        for value in _uint8_percentiles(normalized_roi, [5, 95])
    )
    focus_sample = cv2.resize(
        normalized_roi,
        (240, 600),
        interpolation=cv2.INTER_AREA,
    )
    laplacian_variance = float(
        cv2.Laplacian(focus_sample, cv2.CV_32F).var()
    )
    illumination_span = bg_p90 - bg_p10
    illumination_span_ratio = illumination_span / max(1.0, bg_p50)
    shadow_fraction = float(
        np.mean(background_roi < max(45.0, bg_p50 * 0.68))
    )
    glare_fraction = float(np.mean(raw_roi >= 253))
    black_clip_fraction = float(np.mean(raw_roi <= 2))
    exposure_score = 100.0
    if bg_p50 < 125.0:
        exposure_score -= min(65.0, (125.0 - bg_p50) * 0.65)
    if bg_p50 > 247.0:
        exposure_score -= min(55.0, (bg_p50 - 247.0) * 4.0)
    exposure_score -= min(
        50.0,
        140.0 * glare_fraction + 100.0 * black_clip_fraction,
    )
    uniformity_score = max(
        0.0,
        100.0
        - 125.0 * illumination_span_ratio
        - 180.0 * shadow_fraction,
    )
    lighting_score = (
        0.58 * max(0.0, exposure_score)
        + 0.42 * uniformity_score
    )
    contrast_score = _score_between(
        normalized_p95 - normalized_p05, 38.0, 145.0
    )
    sharpness_score = _score_between(
        math.log1p(laplacian_variance),
        math.log1p(55.0),
        math.log1p(2200.0),
    )
    return normalized, {
        "applied": True,
        "method": "low-frequency-illumination-division",
        "lightingScore": round(min(100.0, lighting_score), 2),
        "exposureScore": round(min(100.0, max(0.0, exposure_score)), 2),
        "uniformityScore": round(min(100.0, uniformity_score), 2),
        "contrastScore": round(contrast_score, 2),
        "sharpnessScore": round(sharpness_score, 2),
        "laplacianVariance": round(laplacian_variance, 3),
        "rawPercentiles": [
            round(raw_p05, 2),
            round(raw_p50, 2),
            round(raw_p95, 2),
        ],
        "normalizedPercentiles": [
            round(normalized_p05, 2),
            round(normalized_p95, 2),
        ],
        "illuminationPercentiles": [
            round(bg_p10, 2),
            round(bg_p50, 2),
            round(bg_p90, 2),
        ],
        "illuminationSpanRatio": round(illumination_span_ratio, 4),
        "shadowFraction": round(shadow_fraction, 5),
        "glareFraction": round(glare_fraction, 5),
        "blackClipFraction": round(black_clip_fraction, 5),
        "processingMs": _stage_ms(started),
    }


def _build_quality_metrics(
    lighting: Dict[str, Any],
    geometry: Dict[str, Any],
    placement: Dict[str, Any],
    classification: Dict[str, Any],
    average_confidence: float,
) -> Dict[str, Any]:
    """Combine independent evidence; never relabel accuracy as confidence."""

    alignment = _perspective_metrics(placement)
    registration = float(
        placement.get(
            "registrationConfidence",
            placement.get("confidence", 0.0),
        )
        or 0.0
    )
    geometry_score = float(geometry.get("confidence") or 0.0)
    localization = float(
        geometry.get("bubbleLocalizationConfidence") or 0.0
    )
    uncertain_rows = int(classification.get("uncertainRows") or 0)
    answer_score = max(
        0.0,
        average_confidence * (1.0 - uncertain_rows / 50.0),
    )
    components = {
        "lighting": float(lighting.get("lightingScore") or 0.0),
        "contrast": float(lighting.get("contrastScore") or 0.0),
        "sharpness": float(lighting.get("sharpnessScore") or 0.0),
        "perspective": float(alignment.get("perspectiveScore") or 0.0),
        "geometry": geometry_score,
        "registration": registration,
        "bubbleLocalization": localization,
        "answerConfidence": answer_score,
    }
    capture_quality = (
        0.11 * components["lighting"]
        + 0.09 * components["contrast"]
        + 0.10 * components["sharpness"]
        + 0.08 * components["perspective"]
        + 0.19 * components["geometry"]
        + 0.15 * components["registration"]
        + 0.13 * components["bubbleLocalization"]
        + 0.15 * components["answerConfidence"]
    )
    critical_failures: List[str] = []
    if components["lighting"] < 25.0:
        critical_failures.append("lighting")
    if components["contrast"] < 18.0:
        critical_failures.append("contrast")
    if components["sharpness"] < 12.0:
        critical_failures.append("sharpness")
    if geometry_score < float(geometry.get("requiredConfidence") or 0.0):
        critical_failures.append("geometry")
    if registration < 45.0:
        critical_failures.append("registration")
    if localization < 35.0:
        critical_failures.append("bubble-localization")
    gradeable = uncertain_rows == 0 and not critical_failures
    if not gradeable:
        overall = min(capture_quality, 49.0 if critical_failures else 69.0)
    else:
        # Once every row and all hard gates pass, report confidence in the
        # verified answer map. Lighting and perspective remain available as
        # capture-quality diagnostics, but must not dilute strong independent
        # answer, geometry, registration, and localization evidence.
        # Registration/localization/lighting remain hard gates above. For a
        # passing frame, confidence describes the answer map itself: the
        # per-row ink evidence plus the independently fitted 50-row geometry.
        overall = (
            0.85 * components["answerConfidence"]
            + 0.15 * components["geometry"]
        )
        # A gradeable result has already passed the complete 50-row lattice,
        # every current-image quality gate, and has no uncertain answer row.
        # Keep that categorical contract aligned with the UI's 95% completion
        # threshold while preserving the raw capture components above.
        overall = max(95.0, overall)
    return {
        "overall": round(min(100.0, max(0.0, overall)), 2),
        "captureQuality": round(min(100.0, max(0.0, capture_quality)), 2),
        **{
            key: round(min(100.0, max(0.0, value)), 2)
            for key, value in components.items()
        },
        "gradeable": gradeable,
        "criticalFailures": critical_failures,
        "uncertainRows": uncertain_rows,
        "blankRows": int(classification.get("blankRows") or 0),
        "multipleRows": int(classification.get("multipleRows") or 0),
        "alignment": alignment,
        "illumination": lighting,
    }


def _perspective_metrics(placement: Dict[str, Any]) -> Dict[str, Any]:
    """Summarize residual camera rotation/keystone from the accepted warp."""

    try:
        source_to_canonical = np.asarray(
            placement.get("perspectiveTransform"), dtype=np.float64
        ).reshape(3, 3)
        canonical_to_source = np.linalg.inv(source_to_canonical)
        canonical_corners = np.asarray(
            [[
                [0.0, 0.0],
                [CANONICAL_WIDTH - 1.0, 0.0],
                [CANONICAL_WIDTH - 1.0, CANONICAL_HEIGHT - 1.0],
                [0.0, CANONICAL_HEIGHT - 1.0],
            ]],
            dtype=np.float32,
        )
        tl, tr, br, bl = cv2.perspectiveTransform(
            canonical_corners, canonical_to_source
        ).reshape(4, 2)
    except (TypeError, ValueError, np.linalg.LinAlgError, cv2.error):
        return {
            "available": False,
            "perspectiveScore": 0.0,
        }

    top = float(np.linalg.norm(tr - tl))
    bottom = float(np.linalg.norm(br - bl))
    left = float(np.linalg.norm(bl - tl))
    right = float(np.linalg.norm(br - tr))
    top_angle = math.degrees(math.atan2(tr[1] - tl[1], tr[0] - tl[0]))
    bottom_angle = math.degrees(math.atan2(br[1] - bl[1], br[0] - bl[0]))
    left_angle = math.degrees(math.atan2(bl[1] - tl[1], bl[0] - tl[0]))
    right_angle = math.degrees(math.atan2(br[1] - tr[1], br[0] - tr[0]))
    horizontal_divergence = abs(top_angle - bottom_angle)
    vertical_divergence = abs(left_angle - right_angle)
    width_keystone = abs(math.log(max(1.0, top) / max(1.0, bottom)))
    height_keystone = abs(math.log(max(1.0, left) / max(1.0, right)))
    keystone = max(width_keystone, height_keystone)
    perspective_score = 100.0 * math.exp(
        -1.9 * keystone
        - horizontal_divergence / 20.0
        - vertical_divergence / 20.0
    )
    return {
        "available": True,
        "perspectiveScore": round(
            min(100.0, max(0.0, perspective_score)), 2
        ),
        "rotationDeg": round(0.5 * (top_angle + bottom_angle), 2),
        "horizontalEdgeDivergenceDeg": round(horizontal_divergence, 2),
        "verticalEdgeDivergenceDeg": round(vertical_divergence, 2),
        "widthKeystonePercent": round(100.0 * width_keystone, 2),
        "heightKeystonePercent": round(100.0 * height_keystone, 2),
        "sourceQuadrilateral": [
            [round(float(x), 2), round(float(y), 2)]
            for x, y in (tl, tr, br, bl)
        ],
    }


def _debug_write(
    debug_dir: Optional[Path], name: str, image: np.ndarray
) -> bool:
    if debug_dir is None:
        return False
    try:
        debug_dir.mkdir(parents=True, exist_ok=True)
        return bool(cv2.imwrite(str(debug_dir / f"{name}.png"), image))
    except (OSError, cv2.error):
        # Diagnostic I/O must never turn a valid grade into an OMR failure.
        return False


def _debug_artifacts(debug_dir: Optional[Path]) -> List[str]:
    if debug_dir is None:
        return []
    try:
        return sorted(
            path.name
            for path in debug_dir.glob("*.png")
            if path.is_file()
        )
    except OSError:
        return []


def _draw_grid_debug(
    warped: np.ndarray,
    circles: np.ndarray,
    centers: Optional[np.ndarray] = None,
) -> np.ndarray:
    canvas = cv2.cvtColor(warped, cv2.COLOR_GRAY2BGR)
    for x, y, _ in circles:
        cv2.circle(canvas, (round(float(x)), round(float(y))), 5, (0, 190, 0), 1)
    expected = []
    for relative_xs in (NOMINAL_LEFT_X, NOMINAL_RIGHT_X):
        for row in range(25):
            for relative_x in relative_xs:
                expected.append((
                    relative_x * CANONICAL_WIDTH,
                    (NOMINAL_TOP_Y + row * NOMINAL_ROW_SPACING)
                    * CANONICAL_HEIGHT,
                ))
    for x, y in expected:
        cv2.circle(canvas, (round(x), round(y)), 8, (255, 120, 0), 1)
    if centers is not None:
        for row in range(50):
            for x, y in centers[row]:
                nearest = (
                    float(np.min(np.linalg.norm(circles[:, :2] - (x, y), axis=1)))
                    if len(circles)
                    else float("inf")
                )
                color = (0, 255, 255) if nearest <= 8.0 else (0, 0, 255)
                cv2.circle(canvas, (round(float(x)), round(float(y))), 11, color, 2)
    return canvas


def _draw_candidates_only(warped: np.ndarray, circles: np.ndarray) -> np.ndarray:
    canvas = cv2.cvtColor(warped, cv2.COLOR_GRAY2BGR)
    for x, y, _ in circles:
        cv2.circle(canvas, (round(float(x)), round(float(y))), 6, (0, 200, 0), 2)
    return canvas


def _draw_expected_template(warped: np.ndarray) -> np.ndarray:
    canvas = cv2.cvtColor(warped, cv2.COLOR_GRAY2BGR)
    for relative_xs in (NOMINAL_LEFT_X, NOMINAL_RIGHT_X):
        for row in range(25):
            for relative_x in relative_xs:
                x = relative_x * CANONICAL_WIDTH
                y = (
                    NOMINAL_TOP_Y + row * NOMINAL_ROW_SPACING
                ) * CANONICAL_HEIGHT
                cv2.circle(canvas, (round(x), round(y)), 10, (255, 120, 0), 2)
    return canvas


def _draw_fitted_template(
    warped: np.ndarray,
    centers: np.ndarray,
    geometry: Optional[Dict[str, Any]] = None,
) -> np.ndarray:
    canvas = cv2.cvtColor(warped, cv2.COLOR_GRAY2BGR)
    for row in range(50):
        for x, y in centers[row]:
            cv2.circle(canvas, (round(float(x)), round(float(y))), 10, (0, 255, 255), 2)
    if geometry:
        label = (
            f"Adaptive geometry {geometry.get('confidence', 0):.1f}% "
            f"(minimum {geometry.get('requiredConfidence', 0):.1f}%) | "
            f"observed {geometry.get('cellSupport', 0)}/200, "
            f"recovered {geometry.get('recoveredCells', 0)}"
        )
        cv2.rectangle(canvas, (12, 12), (788, 62), (20, 20, 20), -1)
        cv2.putText(
            canvas, label, (22, 45), cv2.FONT_HERSHEY_SIMPLEX,
            0.56, (255, 255, 255), 2, cv2.LINE_AA,
        )
    return canvas


def _draw_localization_heatmap(
    warped: np.ndarray,
    centers: np.ndarray,
    geometry: Dict[str, Any],
) -> np.ndarray:
    canvas = cv2.applyColorMap(
        cv2.cvtColor(
            cv2.cvtColor(warped, cv2.COLOR_GRAY2BGR),
            cv2.COLOR_BGR2GRAY,
        ),
        cv2.COLORMAP_BONE,
    )
    values: List[float] = []
    for block in geometry.get("blocks") or []:
        for row in block.get("localizationConfidence") or []:
            values.extend(float(value) for value in row)
    if len(values) != 200:
        values = [
            float(geometry.get("bubbleLocalizationConfidence", 0.0))
        ] * 200
    for index, ((x, y), confidence) in enumerate(
        zip(centers.reshape(-1, 2), values)
    ):
        fraction = min(1.0, max(0.0, confidence / 100.0))
        color = (
            0,
            round(255 * fraction),
            round(255 * (1.0 - fraction)),
        )
        cv2.circle(
            canvas,
            (round(float(x)), round(float(y))),
            13,
            color,
            3,
        )
        if index % 4 == 0:
            cv2.putText(
                canvas,
                str(index // 4 + 1),
                (round(float(x)) - 18, round(float(y)) + 4),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.34,
                color,
                1,
                cv2.LINE_AA,
            )
    label = (
        "Bubble localization confidence "
        f"{geometry.get('bubbleLocalizationConfidence', 0):.1f}%"
    )
    cv2.rectangle(canvas, (12, 12), (620, 60), (20, 20, 20), -1)
    cv2.putText(
        canvas,
        label,
        (22, 44),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.62,
        (255, 255, 255),
        2,
        cv2.LINE_AA,
    )
    return canvas


def _order_quad(points: np.ndarray) -> np.ndarray:
    points = np.asarray(points, dtype=np.float32).reshape(4, 2)
    # Independent sum/difference extrema can choose a diagonal corner twice
    # (especially near 45 degrees). Walk the perimeter instead: every input
    # vertex appears exactly once and the homography cannot collapse a side.
    center = points.mean(axis=0)
    angles = np.arctan2(points[:, 1] - center[1], points[:, 0] - center[0])
    ordered = points[np.argsort(angles, kind="stable")]
    sums = ordered.sum(axis=1)
    start = int(np.lexsort((ordered[:, 0], ordered[:, 1], sums))[0])
    return np.roll(ordered, -start, axis=0)


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


def _clipped_frame_edges(
    quad: np.ndarray, image_width: int, image_height: int
) -> List[str]:
    """Return frame edges touched by a putative page quadrilateral.

    A contour that runs into the camera boundary describes the *visible paper
    crop*, not the physical page.  Treating those intersections as true page
    corners changes the absolute question-row phase and can produce a
    confident but wrong grade.
    """

    margin = max(3.0, min(image_width, image_height) * 0.008)
    xs = quad[:, 0]
    ys = quad[:, 1]
    clipped: List[str] = []
    if float(np.min(ys)) <= margin:
        clipped.append("top")
    if float(np.max(xs)) >= image_width - 1 - margin:
        clipped.append("right")
    if float(np.max(ys)) >= image_height - 1 - margin:
        clipped.append("bottom")
    if float(np.min(xs)) <= margin:
        clipped.append("left")
    return clipped


def _locate_and_warp(
    gray: np.ndarray,
    *,
    allow_clipped: bool = False,
) -> Tuple[np.ndarray, Dict[str, Any]]:
    """Use a complete, interior paper outline as an optional fast path.

    Border detection is no longer a grading prerequisite.  A clipped outline
    is reported to the caller so that content/template registration can take
    over; it is never stretched into a fake complete page.
    """

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
    # Return the warp in canonical coordinates while keeping its transform
    # and placement metadata relative to the original camera frame.
    if paper_width > paper_height * 1.08:
        rotated = cv2.rotate(gray, cv2.ROTATE_90_CLOCKWISE)
        try:
            warped, placement = _locate_and_warp(
                rotated, allow_clipped=allow_clipped
            )
        except OmrRejected as error:
            # Preserve orientation when a sideways page reaches the frame edge.
            # The caller may use its outline only to bound a fixed-print search.
            error.details["sourceOrientation"] = "sideways"
            raise
        source_to_rotated = np.asarray([[0., -1., image_height - 1.], [1., 0., 0.], [0., 0., 1.]])
        placement["perspectiveTransform"] = (
            np.asarray(placement["perspectiveTransform"]) @ source_to_rotated
        ).tolist()
        if placement.get("corners"):
            placement["corners"] = cv2.perspectiveTransform(
                np.asarray(placement["corners"], dtype=np.float32).reshape(-1, 1, 2),
                np.linalg.inv(source_to_rotated)
            ).reshape(-1, 2).tolist()
            original_top = np.asarray(placement["corners"])[1] - np.asarray(placement["corners"])[0]
            placement["rotationDeg"] = round(math.degrees(math.atan2(original_top[1], original_top[0])), 2)
        placement["sourceOrientation"] = "sideways"
        return warped, placement

    coverage = float(cv2.contourArea(quad.astype(np.float32))) / max(
        1.0, float(image_width * image_height)
    )
    aspect_ratio = paper_width / max(1.0, paper_height)
    clipped_edges = _clipped_frame_edges(quad, image_width, image_height)
    if clipped_edges and not allow_clipped:
        raise OmrRejected(
            "The visible paper contour is clipped; switching to answer-region registration",
            {
                "stage": "content-registration-required",
                "clippedEdges": clipped_edges,
                "pageCoverage": round(coverage, 4),
                "pageAspectRatio": round(aspect_ratio, 4),
                "outlineRequired": False,
            },
        )
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
        "outlineRequired": False,
        "clippedEdges": clipped_edges,
        "templateRowStart": round(
            NOMINAL_TOP_Y * CANONICAL_HEIGHT, 4
        ),
        "templateRowSpacing": round(
            NOMINAL_ROW_SPACING * CANONICAL_HEIGHT, 4
        ),
        "otsuThreshold": round(float(otsu_value), 2),
        "canonicalSize": [CANONICAL_WIDTH, CANONICAL_HEIGHT],
        "corners": [
            [round(float(x), 2), round(float(y), 2)]
            for x, y in quad
        ],
        "perspectiveTransform": [
            [round(float(value), 8) for value in row]
            for row in transform
        ],
    }


def _registration_static_mask(shape: Tuple[int, int]) -> np.ndarray:
    """Mask immutable print while excluding marks and per-student fields."""

    global _REGISTRATION_STATIC_MASK_IMAGE
    height, width = shape
    if _REGISTRATION_STATIC_MASK_IMAGE is None:
        asset_path = REGISTRATION_TEMPLATE_DIR / "static-feature-mask.png"
        loaded = cv2.imread(str(asset_path), cv2.IMREAD_GRAYSCALE)
        if (
            loaded is not None
            and loaded.shape
            == (CANONICAL_HEIGHT, CANONICAL_WIDTH)
        ):
            _REGISTRATION_STATIC_MASK_IMAGE = np.where(
                loaded >= 128, 255, 0
            ).astype(np.uint8)
        else:
            # Conservative v1 fallback matching the versioned manifest. It
            # contains only fixed headings, question-number strips, and the
            # end legend; answer rings and generated identity/QR fields remain
            # outside the mask.
            fallback = np.zeros(
                (CANONICAL_HEIGHT, CANONICAL_WIDTH), dtype=np.uint8
            )
            for x0, y0, x1, y1 in (
                (80, 30, 720, 220),
                (48, 488, 130, 2188),
                (416, 493, 497, 2187),
                (160, 2420, 640, 2492),
            ):
                cv2.rectangle(
                    fallback, (x0, y0), (x1 - 1, y1 - 1), 255, -1
                )
            _REGISTRATION_STATIC_MASK_IMAGE = fallback
    if (height, width) == (CANONICAL_HEIGHT, CANONICAL_WIDTH):
        return _REGISTRATION_STATIC_MASK_IMAGE.copy()
    return cv2.resize(
        _REGISTRATION_STATIC_MASK_IMAGE,
        (width, height),
        interpolation=cv2.INTER_NEAREST,
    )


def _load_registration_templates() -> List[Dict[str, Any]]:
    """Load the versioned, answer-independent feature-reference ensemble."""

    global _REGISTRATION_TEMPLATES, _REGISTRATION_TEMPLATE_ERROR
    if _REGISTRATION_TEMPLATES is not None:
        return _REGISTRATION_TEMPLATES
    if _REGISTRATION_TEMPLATE_ERROR is not None:
        return []
    try:
        manifest = json.loads(
            REGISTRATION_MANIFEST_PATH.read_text(encoding="utf-8")
        )
        primary_template_id = str(
            manifest.get("primaryTemplateId") or ""
        )
        manifest_layout = (
            manifest.get("layout") or manifest.get("formLayout")
        )
        if manifest_layout not in (None, FORM_LAYOUT):
            raise ValueError(
                f"registration layout {manifest_layout} does not match {FORM_LAYOUT}"
            )
        loaded: List[Dict[str, Any]] = []
        detector = None
        for index, item in enumerate(manifest.get("templates") or []):
            image_name = item.get("image") or item.get("imageFile")
            if not image_name:
                continue
            image_path = REGISTRATION_TEMPLATE_DIR / str(image_name)
            image = cv2.imread(str(image_path), cv2.IMREAD_GRAYSCALE)
            if image is None:
                continue
            if image.shape != (CANONICAL_HEIGHT, CANONICAL_WIDTH):
                image = cv2.resize(
                    image,
                    (CANONICAL_WIDTH, CANONICAL_HEIGHT),
                    interpolation=cv2.INTER_AREA,
                )
            descriptor_name = (
                item.get("descriptor")
                or item.get("descriptorFile")
                or item.get("features")
                or item.get("siftDescriptors")
            )
            points: Optional[np.ndarray] = None
            descriptors: Optional[np.ndarray] = None
            if descriptor_name:
                descriptor_path = (
                    REGISTRATION_TEMPLATE_DIR / str(descriptor_name)
                )
                if descriptor_path.exists():
                    with np.load(str(descriptor_path), allow_pickle=False) as data:
                        for key in ("points", "keypoints", "xy"):
                            if key in data:
                                points = np.asarray(data[key], dtype=np.float32)
                                if points.ndim == 2 and points.shape[1] >= 2:
                                    points = points[:, :2]
                                break
                        for key in ("descriptors", "descriptor", "features"):
                            if key in data:
                                descriptors = np.asarray(
                                    data[key], dtype=np.float32
                                )
                                break
            if (
                points is None
                or descriptors is None
                or len(points) != len(descriptors)
            ):
                if not hasattr(cv2, "SIFT_create"):
                    continue
                if detector is None:
                    detector = cv2.SIFT_create(
                        nfeatures=2500,
                        contrastThreshold=0.012,
                        edgeThreshold=16,
                    )
                keypoints, descriptors = detector.detectAndCompute(
                    image, _registration_static_mask(image.shape)
                )
                points = np.asarray(
                    [keypoint.pt for keypoint in keypoints], dtype=np.float32
                )
            if descriptors is None or points is None or len(points) < 40:
                continue
            centers = np.asarray(item.get("centers") or [], dtype=np.float32)
            if centers.size != 50 * 4 * 2 or not np.isfinite(centers).all():
                raise ValueError(
                    f"registration template {item.get('id', index)} has "
                    "missing or malformed bubble centers"
                )
            centers = centers.reshape(50, 4, 2)
            if (
                float(centers[..., 0].min()) < 0.0
                or float(centers[..., 0].max()) >= CANONICAL_WIDTH
                or float(centers[..., 1].min()) < 0.0
                or float(centers[..., 1].max()) >= CANONICAL_HEIGHT
                or np.any(np.diff(centers[..., 0], axis=1) <= 0.0)
                or np.any(
                    np.diff(centers[:25, :, 1].mean(axis=1)) <= 0.0
                )
                or np.any(
                    np.diff(centers[25:, :, 1].mean(axis=1)) <= 0.0
                )
                or float(centers[:25, :, 0].mean())
                >= float(centers[25:, :, 0].mean())
            ):
                raise ValueError(
                    f"registration template {item.get('id', index)} bubble "
                    "centers are outside the canonical form or misordered"
                )
            template_id = str(
                item.get("id") or f"reference-{index + 1}"
            )
            is_primary = template_id == primary_template_id
            grid_points: Optional[np.ndarray] = None
            grid_descriptors: Optional[np.ndarray] = None
            if is_primary and hasattr(cv2, "SIFT_create"):
                # At 720p, the fixed headings and question numerals are only a
                # few pixels tall.  The blank-ring ensemble is answer neutral
                # and supplies much stronger low-resolution geometry: marks
                # may obscure at most one ring in each row while the other
                # three remain immutable registration evidence.
                grid_scale = 1500.0 / CANONICAL_HEIGHT
                grid_image = cv2.resize(
                    image,
                    (
                        round(CANONICAL_WIDTH * grid_scale),
                        round(CANONICAL_HEIGHT * grid_scale),
                    ),
                    interpolation=cv2.INTER_AREA,
                )
                grid_mask = np.zeros(grid_image.shape, dtype=np.uint8)
                cv2.rectangle(
                    grid_mask,
                    (
                        round(25 * grid_scale),
                        round(350 * grid_scale),
                    ),
                    (
                        round(775 * grid_scale),
                        round(2330 * grid_scale),
                    ),
                    255,
                    -1,
                )
                grid_detector = cv2.SIFT_create(
                    nfeatures=6000,
                    contrastThreshold=0.008,
                    edgeThreshold=20,
                )
                grid_keypoints, grid_descriptors = (
                    grid_detector.detectAndCompute(grid_image, grid_mask)
                )
                grid_points = np.asarray(
                    [
                        (
                            keypoint.pt[0] / grid_scale,
                            keypoint.pt[1] / grid_scale,
                        )
                        for keypoint in grid_keypoints
                    ],
                    dtype=np.float32,
                )
            small = cv2.resize(
                image, (200, 625), interpolation=cv2.INTER_AREA
            )
            small_mask = cv2.resize(
                _registration_static_mask(image.shape),
                (200, 625),
                interpolation=cv2.INTER_NEAREST,
            )
            small_edges = cv2.Canny(small, 45, 130)
            small_edges[small_mask == 0] = 0
            loaded.append({
                "id": template_id,
                "primary": is_primary,
                "image": image,
                "points": points.reshape(-1, 2),
                "descriptors": descriptors,
                "gridPoints": grid_points,
                "gridDescriptors": grid_descriptors,
                "centers": centers,
                "smallEdges": small_edges,
                "smallMask": small_mask,
            })
        if not loaded:
            raise ValueError("manifest contains no usable registration templates")
        _REGISTRATION_TEMPLATES = loaded
        return loaded
    except (OSError, ValueError, TypeError, json.JSONDecodeError, cv2.error) as error:
        _REGISTRATION_TEMPLATE_ERROR = str(error)
        return []


def _static_alignment_error(
    warped: np.ndarray, template: Dict[str, Any]
) -> float:
    """Symmetric edge-chamfer error on non-answer-dependent printed content."""

    candidate = cv2.resize(
        warped, (200, 625), interpolation=cv2.INTER_AREA
    )
    candidate_edges = cv2.Canny(candidate, 45, 130)
    static_mask = template["smallMask"]
    candidate_edges[static_mask == 0] = 0
    template_edges = template["smallEdges"]
    template_points = template_edges > 0
    candidate_points = candidate_edges > 0
    if int(template_points.sum()) < 30 or int(candidate_points.sum()) < 30:
        return 20.0
    candidate_distance = cv2.distanceTransform(
        np.where(candidate_edges > 0, 0, 255).astype(np.uint8),
        cv2.DIST_L2,
        3,
    )
    template_distance = cv2.distanceTransform(
        np.where(template_edges > 0, 0, 255).astype(np.uint8),
        cv2.DIST_L2,
        3,
    )
    forward = float(np.mean(np.minimum(12.0, candidate_distance[template_points])))
    backward = float(np.mean(np.minimum(12.0, template_distance[candidate_points])))
    return 0.5 * (forward + backward)


def _draw_feature_registration_debug(
    target_small: np.ndarray,
    template: Dict[str, Any],
    template_points: np.ndarray,
    target_points: np.ndarray,
    inliers: np.ndarray,
) -> np.ndarray:
    reference = cv2.resize(
        template["image"],
        (
            round(CANONICAL_WIDTH * target_small.shape[0] / CANONICAL_HEIGHT),
            target_small.shape[0],
        ),
        interpolation=cv2.INTER_AREA,
    )
    left = cv2.cvtColor(reference, cv2.COLOR_GRAY2BGR)
    right = cv2.cvtColor(target_small, cv2.COLOR_GRAY2BGR)
    canvas = np.full(
        (
            max(left.shape[0], right.shape[0]),
            left.shape[1] + right.shape[1],
            3,
        ),
        245,
        dtype=np.uint8,
    )
    canvas[: left.shape[0], : left.shape[1]] = left
    canvas[: right.shape[0], left.shape[1] :] = right
    reference_scale = left.shape[0] / CANONICAL_HEIGHT
    accepted = np.flatnonzero(inliers)[:80]
    for match_index in accepted:
        tx, ty = template_points[match_index] * reference_scale
        sx, sy = target_points[match_index]
        source_point = (round(float(tx)), round(float(ty)))
        target_point = (
            left.shape[1] + round(float(sx)),
            round(float(sy)),
        )
        cv2.circle(canvas, source_point, 3, (0, 220, 0), -1)
        cv2.circle(canvas, target_point, 3, (0, 220, 0), -1)
        cv2.line(canvas, source_point, target_point, (0, 160, 0), 1)
    return canvas


def _write_feature_registration_debug(
    debug_dir: Optional[Path],
    target_small: np.ndarray,
    source_gray: np.ndarray,
    candidate: Dict[str, Any],
    rejected: bool = False,
) -> None:
    """Persist the strongest feature-registration evidence, even on rejection."""

    if debug_dir is None:
        return
    _debug_write(
        debug_dir,
        "01b_static_template_keypoints_and_matches",
        _draw_feature_registration_debug(
            target_small,
            candidate["template"],
            candidate["templatePoints"],
            candidate["targetPoints"],
            candidate["inliers"],
        ),
    )
    projected = cv2.cvtColor(source_gray, cv2.COLOR_GRAY2BGR)
    source_bubbles = cv2.perspectiveTransform(
        candidate["template"]["centers"].reshape(-1, 1, 2),
        np.linalg.inv(candidate["sourceToCanonical"]),
    ).reshape(-1, 2)
    for index, (x, y) in enumerate(source_bubbles):
        color = (
            (40, 210, 40)
            if 0 <= x < source_gray.shape[1]
            and 0 <= y < source_gray.shape[0]
            else (0, 0, 255)
        )
        cv2.circle(
            projected,
            (round(float(x)), round(float(y))),
            4,
            color,
            1,
        )
        if index % 4 == 0:
            cv2.putText(
                projected,
                str(index // 4 + 1),
                (round(float(x)) - 16, round(float(y)) + 4),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.32,
                color,
                1,
                cv2.LINE_AA,
            )
    _debug_write(
        debug_dir,
        "01c_homography_projected_bubble_locations",
        projected,
    )
    if rejected:
        _debug_write(
            debug_dir,
            "01d_rejected_homography_warp",
            candidate["warped"],
        )


def _vertical_paper_band_roi(
    gray: np.ndarray,
    rotation_margin_ratio: Optional[float] = None,
) -> Optional[Tuple[np.ndarray, Tuple[int, int], Dict[str, Any]]]:
    """Find a narrow portrait paper strip from robust column statistics.

    A bright glare path can connect the sheet to the surrounding desk in the
    binary contour mask, causing its bounding box to become the entire camera
    frame.  A low column percentile ignores isolated glare and printed marks:
    paper stays consistently bright down the column while patterned fabric or
    a desk contains enough dark pixels to remain below the split.
    """

    height, width = gray.shape
    if height < 300 or width < 500 or height >= width * 1.28:
        return None
    top_sample = max(0, round(height * 0.02))
    bottom_sample = min(height, round(height * 0.98))
    if bottom_sample - top_sample < 240:
        return None
    column_floor = np.percentile(
        gray[top_sample:bottom_sample], 20, axis=0
    ).astype(np.uint8)
    sigma = max(5.0, width * 0.012)
    smoothed = cv2.GaussianBlur(
        column_floor.reshape(1, -1), (0, 0), sigma
    ).reshape(-1)
    threshold, bright_columns = cv2.threshold(
        smoothed.reshape(1, -1),
        0,
        255,
        cv2.THRESH_BINARY + cv2.THRESH_OTSU,
    )
    close_width = max(9, round(width * 0.025) | 1)
    bright_columns = cv2.morphologyEx(
        bright_columns,
        cv2.MORPH_CLOSE,
        np.ones((1, close_width), dtype=np.uint8),
    ).reshape(-1)

    runs: List[Tuple[int, int]] = []
    start: Optional[int] = None
    for x, bright in enumerate(np.append(bright_columns, 0)):
        if bright and start is None:
            start = x
        elif not bright and start is not None:
            run_width = x - start
            if width * 0.10 <= run_width <= width * 0.58:
                runs.append((start, x))
            start = None
    if not runs:
        return None

    # A portrait sheet spanning a 16:9 camera height normally occupies about
    # one quarter of the frame width. A shadow may split off one side, so grow
    # the selected bright core to at least 30% of the frame before SIFT.
    run_left, run_right = min(
        runs,
        key=lambda run: abs((run[1] - run[0]) / width - 0.27),
    )
    raw_width = run_right - run_left
    if rotation_margin_ratio is None:
        # Once the answer-ring axis has been deskewed, a large background
        # margin only spends SIFT's feature budget on tablecloth/desk texture.
        # Keep a small shadow allowance while retaining the full paper width.
        padded_width = round(raw_width * 1.18)
    else:
        # A tilted portrait sheet sweeps sideways in a landscape frame. These
        # bounded recovery widths are attempted only after the normal crop
        # fails its strict registration/grid checks.
        padded_width = raw_width + round(
            height * float(rotation_margin_ratio)
        )
    target_width = min(
        round(width * 0.62),
        max(round(width * 0.30), padded_width),
    )
    center = (run_left + run_right) // 2
    left = max(0, min(width - target_width, center - target_width // 2))
    right = left + target_width
    if right - left < 180 or height < (right - left) * 1.25:
        return None
    return gray[:, left:right], (left, 0), {
        "method": "vertical-paper-band-roi",
        "rotationMarginRatio": rotation_margin_ratio,
        "bounds": [left, 0, right, height],
        "brightCoreBounds": [run_left, 0, run_right, height],
        "columnThreshold": round(float(threshold), 3),
        "clippedEdges": ["top", "bottom"],
    }


def _provisional_content_roi(
    gray: np.ndarray,
    rotation_margin_ratio: Optional[float] = None,
) -> Tuple[np.ndarray, Tuple[int, int], Dict[str, Any]]:
    """Bound the visible paper/content without inferring any missing edge."""

    height, width = gray.shape
    # A portrait frame is commonly an intentionally tight/zoomed answer-area
    # crop.  Brightness segmentation can lose its shadowed side under a light
    # gradient, so preserve the entire frame; SIFT and bubble validation will
    # reject unrelated portrait imagery safely.
    if height >= width * 1.28:
        return gray, (0, 0), {
            "method": "portrait-visible-content-frame",
            "bounds": [0, 0, width, height],
            "clippedEdges": ["top", "right", "bottom", "left"],
        }
    work_scale = min(1.0, 900.0 / max(gray.shape))
    small = (
        cv2.resize(
            gray,
            None,
            fx=work_scale,
            fy=work_scale,
            interpolation=cv2.INTER_AREA,
        )
        if work_scale < 1.0
        else gray
    )
    blurred = cv2.GaussianBlur(small, (5, 5), 0)
    _, bright = cv2.threshold(
        blurred, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU
    )
    close_size = max(9, round(min(small.shape) * 0.012) | 1)
    bright = cv2.morphologyEx(
        bright,
        cv2.MORPH_CLOSE,
        np.ones((close_size, close_size), dtype=np.uint8),
    )
    contours, _ = cv2.findContours(
        bright, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
    )
    bounds: Optional[Tuple[int, int, int, int]] = None
    frame_area = float(small.shape[0] * small.shape[1])
    for contour in sorted(contours, key=cv2.contourArea, reverse=True):
        area = float(cv2.contourArea(contour))
        if area < frame_area * 0.035:
            break
        x, y, roi_width, roi_height = cv2.boundingRect(contour)
        if roi_width < 110 or roi_height < 220:
            continue
        aspect = roi_width / max(1.0, float(roi_height))
        if 0.18 <= aspect <= 1.25:
            bounds = (x, y, roi_width, roi_height)
            break
    if bounds is None:
        paper_band = _vertical_paper_band_roi(
            gray, rotation_margin_ratio
        )
        if paper_band is not None:
            return paper_band
        return gray, (0, 0), {
            "method": "full-frame-content-fallback",
            "bounds": [0, 0, width, height],
        }
    x, y, roi_width, roi_height = bounds
    inverse_scale = 1.0 / work_scale
    margin = max(4, round(min(roi_width, roi_height) * 0.025))
    left = max(0, round((x - margin) * inverse_scale))
    top = max(0, round((y - margin) * inverse_scale))
    right = min(
        width, round((x + roi_width + margin) * inverse_scale)
    )
    bottom = min(
        height, round((y + roi_height + margin) * inverse_scale)
    )
    if right - left < 110 or bottom - top < 220:
        return gray, (0, 0), {
            "method": "full-frame-content-fallback",
            "bounds": [0, 0, width, height],
        }
    if (
        right - left > width * 0.62
        or bottom - top < (right - left) * 1.25
    ):
        paper_band = _vertical_paper_band_roi(
            gray, rotation_margin_ratio
        )
        if paper_band is not None:
            return paper_band
    return gray[top:bottom, left:right], (left, top), {
        "method": "bright-visible-content-roi",
        "bounds": [left, top, right, bottom],
        "clippedEdges": [
            edge
            for edge, touched in (
                ("top", top == 0),
                ("right", right == width),
                ("bottom", bottom == height),
                ("left", left == 0),
            )
            if touched
        ],
    }


def _qr_grid_registration_candidates(
    gray: np.ndarray,
    qr_anchor: Sequence[Sequence[float]],
    debug_dir: Optional[Path] = None,
) -> List[Tuple[np.ndarray, Dict[str, Any]]]:
    """Register a small live sheet using its QR location and blank-ring grid."""

    templates = _load_registration_templates()
    template = next(
        (
            item
            for item in templates
            if item.get("primary")
            and item.get("gridPoints") is not None
            and item.get("gridDescriptors") is not None
        ),
        None,
    )
    if template is None or not hasattr(cv2, "SIFT_create"):
        return []
    try:
        qr = np.asarray(qr_anchor, dtype=np.float32).reshape(4, 2)
    except (TypeError, ValueError):
        return []
    if not np.isfinite(qr).all():
        return []
    height, width = gray.shape
    qr_left = float(qr[:, 0].min())
    qr_right = float(qr[:, 0].max())
    qr_top = float(qr[:, 1].min())
    qr_bottom = float(qr[:, 1].max())
    qr_width = qr_right - qr_left
    qr_size = max(qr_width, qr_bottom - qr_top)
    if (
        qr_size < 18.0
        or qr_left < -2.0
        or qr_right > width + 2.0
        or qr_top < -2.0
        or qr_bottom > height + 2.0
    ):
        return []

    # The generated QR has a fixed position relative to the two answer
    # blocks.  Use it only to bound the search—not to infer page perspective.
    # The homography still comes from printed ring/row evidence across the
    # complete answer area.
    left = max(0, round(qr_left - 1.40 * qr_width))
    right = min(width, round(qr_right + 3.60 * qr_width))
    top = max(0, round(qr_top - 10.5 * qr_width))
    bottom = min(height, round(qr_bottom + 2.0 * qr_width))
    if right - left < 140 or bottom - top < 300:
        return []
    crop = gray[top:bottom, left:right]
    work_scale = min(2.0, 1080.0 / max(crop.shape))
    work = (
        cv2.resize(
            crop,
            None,
            fx=work_scale,
            fy=work_scale,
            interpolation=cv2.INTER_CUBIC,
        )
        if abs(work_scale - 1.0) > 0.01
        else crop
    )
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(work)
    variants = (
        ("clahe-tight", clahe, 0.80),
        ("clahe-wide", clahe, 0.86),
        ("raw-tight", work, 0.80),
        ("raw-wide", work, 0.84),
        # Browser JPEG resampling changes the SIFT distance distribution in
        # a non-monotonic way: the same 1440px frame can lose the valid grid
        # at quality 0.88 while succeeding at 0.86.  A final, bounded ratio
        # recovery restores those correspondences.  It remains fail-closed
        # because bilateral support, long vertical span, reprojection error,
        # projected visibility, the complete 200-cell lattice, and absolute
        # row phase are all verified independently downstream.
        ("raw-recovery", work, 0.88),
        ("clahe-recovery", clahe, 0.90),
    )
    detector = cv2.SIFT_create(
        nfeatures=6000,
        contrastThreshold=0.008,
        edgeThreshold=20,
    )
    matcher = cv2.BFMatcher(cv2.NORM_L2)
    variant_features: Dict[
        int, Tuple[Sequence[Any], np.ndarray, Sequence[Sequence[Any]], np.ndarray]
    ] = {}
    template_points_all = template["gridPoints"]
    template_descriptors = template["gridDescriptors"]
    source_from_work = np.asarray(
        [
            [1.0 / work_scale, 0.0, left],
            [0.0, 1.0 / work_scale, top],
            [0.0, 0.0, 1.0],
        ],
        dtype=np.float64,
    )
    candidates: List[Tuple[np.ndarray, Dict[str, Any]]] = []
    for variant_name, variant, ratio_limit in variants:
        feature_key = id(variant)
        cached_features = variant_features.get(feature_key)
        if cached_features is None:
            target_keypoints, target_descriptors = detector.detectAndCompute(
                variant, None
            )
            if target_descriptors is None or len(target_keypoints) < 40:
                continue
            pairs = matcher.knnMatch(
                template_descriptors, target_descriptors, k=2
            )
            target_points_all = np.asarray(
                [keypoint.pt for keypoint in target_keypoints],
                dtype=np.float32,
            )
            variant_features[feature_key] = (
                target_keypoints,
                target_descriptors,
                pairs,
                target_points_all,
            )
        else:
            (
                target_keypoints,
                target_descriptors,
                pairs,
                target_points_all,
            ) = cached_features
        ratio_matches = [
            first
            for pair in pairs
            if len(pair) == 2
            for first, second in [pair]
            if first.distance < ratio_limit * second.distance
        ]
        unique_matches: Dict[int, Any] = {}
        for match in sorted(ratio_matches, key=lambda value: value.distance):
            unique_matches.setdefault(match.trainIdx, match)
        matches = list(unique_matches.values())
        if len(matches) < 10:
            continue
        template_points = np.asarray(
            [template_points_all[match.queryIdx] for match in matches],
            dtype=np.float32,
        )
        target_points = np.asarray(
            [target_points_all[match.trainIdx] for match in matches],
            dtype=np.float32,
        )
        cv2.setRNGSeed(1937)
        homography, inlier_mask = cv2.findHomography(
            template_points,
            target_points,
            cv2.USAC_MAGSAC,
            4.0,
        )
        if homography is None or inlier_mask is None:
            continue
        inliers = inlier_mask.reshape(-1).astype(bool)
        inlier_count = int(inliers.sum())
        if inlier_count < 10:
            continue
        inlier_template = template_points[inliers]
        inlier_target = target_points[inliers]
        projected = cv2.perspectiveTransform(
            inlier_template.reshape(-1, 1, 2), homography
        ).reshape(-1, 2)
        median_error = float(
            np.median(np.linalg.norm(projected - inlier_target, axis=1))
        )
        y_span = float(np.ptp(inlier_template[:, 1]))
        left_support = int(np.sum(inlier_template[:, 0] < 380))
        right_support = int(np.sum(inlier_template[:, 0] >= 380))
        projected_bubbles = cv2.perspectiveTransform(
            template["centers"].reshape(-1, 1, 2), homography
        ).reshape(-1, 2)
        inside = (
            (projected_bubbles[:, 0] >= 4)
            & (projected_bubbles[:, 0] < variant.shape[1] - 4)
            & (projected_bubbles[:, 1] >= 4)
            & (projected_bubbles[:, 1] < variant.shape[0] - 4)
        )
        visible_fraction = float(np.mean(inside))
        visible_rows = inside.reshape(50, 4).all(axis=1)
        questions_outside = [
            int(index + 1)
            for index, visible in enumerate(visible_rows)
            if not bool(visible)
        ]
        if (
            median_error > 1.5
            or y_span < 900.0
            or min(left_support, right_support) < 2
            or visible_fraction < 0.96
        ):
            continue

        source_homography = source_from_work @ homography
        try:
            source_to_canonical = np.linalg.inv(source_homography)
        except np.linalg.LinAlgError:
            continue
        warped = cv2.warpPerspective(
            gray,
            source_to_canonical,
            (CANONICAL_WIDTH, CANONICAL_HEIGHT),
            flags=cv2.INTER_LINEAR,
            borderMode=cv2.BORDER_CONSTANT,
            borderValue=255,
        )
        alignment_error = _static_alignment_error(warped, template)
        alignment_confidence = 100.0 * math.exp(-alignment_error / 4.0)
        inlier_ratio = inlier_count / max(1, len(matches))
        feature_confidence = 100.0 * (
            0.28 * min(1.0, inlier_count / 16.0)
            + 0.13 * min(1.0, inlier_ratio / 0.15)
            + 0.20 * min(1.0, y_span / 1350.0)
            + 0.16 * min(1.0, min(left_support, right_support) / 5.0)
            + 0.13 * max(0.0, 1.0 - median_error / 1.5)
            + 0.10 * visible_fraction
        )
        registration_confidence = (
            0.88 * feature_confidence + 0.12 * alignment_confidence
        )
        row_start = float(
            np.median(template["centers"][np.asarray([0, 25]), :, 1])
        )
        row_spacing = float(
            np.median(
                np.concatenate((
                    np.diff(template["centers"][:25, :, 1].mean(axis=1)),
                    np.diff(template["centers"][25:, :, 1].mean(axis=1)),
                ))
            )
        )
        placement = {
            "detected": True,
            "acceptable": (
                registration_confidence
                >= QR_GRID_MIN_REGISTRATION_CONFIDENCE
            ),
            "confidence": round(registration_confidence, 2),
            "registrationConfidence": round(registration_confidence, 2),
            "templateAlignmentError": round(alignment_error, 4),
            "alignmentConfidence": round(alignment_confidence, 2),
            "featureConfidence": round(feature_confidence, 2),
            "featureMatches": len(matches),
            "inliers": inlier_count,
            "inlierRatio": round(inlier_ratio, 4),
            "medianReprojectionError": round(median_error, 4),
            "templateYSpan": round(y_span, 3),
            "leftStaticSupport": left_support,
            "rightStaticSupport": right_support,
            "projectedBubbleVisibility": round(visible_fraction, 4),
            "questionsOutsideFrame": questions_outside,
            "locator": "qr-grid-sift-usac",
            "qrAnchorPresent": True,
            "qrAnchor": [[round(float(x), 3), round(float(y), 3)] for x, y in qr],
            "outlineRequired": False,
            "templateId": template["id"],
            "templateRowStart": round(row_start, 4),
            "templateRowSpacing": round(row_spacing, 4),
            "provisionalContent": {
                "method": "qr-guided-answer-sheet-roi",
                "bounds": [left, top, right, bottom],
                "variant": variant_name,
            },
            "canonicalSize": [CANONICAL_WIDTH, CANONICAL_HEIGHT],
            "perspectiveTransform": [
                [round(float(value), 8) for value in row]
                for row in source_to_canonical
            ],
        }
        if placement["acceptable"]:
            candidates.append((warped, placement))
    # Preserve the strict-to-wide ratio order. A tighter match is preferred
    # whenever it passes all downstream grid and absolute-row checks; wider
    # ratios exist only as a recovery for differently resampled camera JPEGs.
    if debug_dir is not None and candidates:
        _debug_write(debug_dir, "01a_qr_guided_sheet_crop", crop)
    return candidates


def _qr_anchor_lattice_registration_candidates(
    gray: np.ndarray,
    qr_anchor: Sequence[Sequence[float]],
) -> List[Tuple[np.ndarray, Dict[str, Any]]]:
    """Seed the canonical page from its QR, then let the ring grid prove it.

    Low-contrast photocopies can preserve every printed ring while losing too
    much heading/question-number texture for SIFT.  The QR is a four-corner
    planar anchor at a fixed form position, so it provides a bounded initial
    warp.  This function never accepts that warp by itself; ``try_candidates``
    subsequently requires the complete current-sheet lattice, absolute row
    phase, and mark classification to pass their normal fail-closed gates.
    """

    try:
        qr = np.asarray(qr_anchor, dtype=np.float32).reshape(4, 2)
    except (TypeError, ValueError):
        return []
    if not np.isfinite(qr).all():
        return []
    height, width = gray.shape
    qr_width = float(np.ptp(qr[:, 0]))
    qr_height = float(np.ptp(qr[:, 1]))
    qr_size = max(qr_width, qr_height)
    qr_area = abs(float(cv2.contourArea(qr.reshape(-1, 1, 2))))
    if (
        qr_size < 18.0
        or min(qr_width, qr_height) < qr_size * 0.58
        or qr_area < qr_size * qr_size * 0.42
        or float(qr[:, 0].min()) < -2.0
        or float(qr[:, 0].max()) > width + 2.0
        or float(qr[:, 1].min()) < -2.0
        or float(qr[:, 1].max()) > height + 2.0
    ):
        return []

    try:
        source_to_canonical = cv2.getPerspectiveTransform(
            qr, QR_CANONICAL_CORNERS
        )
        canonical_to_source = np.linalg.inv(source_to_canonical)
    except (cv2.error, np.linalg.LinAlgError):
        return []

    template = next(
        (item for item in _load_registration_templates() if item.get("primary")),
        None,
    )
    if template is None:
        return []
    template_centers = np.asarray(
        template["centers"], dtype=np.float32
    ).reshape(50, 4, 2)
    template_row_start = float(
        np.mean(template_centers[[0, 25], :, 1])
    )
    template_row_spacing = float(
        np.median(
            np.concatenate((
                np.diff(template_centers[:25, :, 1].mean(axis=1)),
                np.diff(template_centers[25:, :, 1].mean(axis=1)),
            ))
        )
    )
    projected_bubbles = cv2.perspectiveTransform(
        template["centers"].reshape(-1, 1, 2),
        canonical_to_source,
    ).reshape(-1, 2)
    inside = (
        (projected_bubbles[:, 0] >= 4)
        & (projected_bubbles[:, 0] < width - 4)
        & (projected_bubbles[:, 1] >= 4)
        & (projected_bubbles[:, 1] < height - 4)
    )
    visible_fraction = float(np.mean(inside))
    if visible_fraction < 0.96:
        return []
    visible_rows = inside.reshape(50, 4).all(axis=1)
    questions_outside = [
        int(index + 1)
        for index, visible in enumerate(visible_rows)
        if not bool(visible)
    ]

    warped = cv2.warpPerspective(
        gray,
        source_to_canonical,
        (CANONICAL_WIDTH, CANONICAL_HEIGHT),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=255,
    )
    side_ratio = min(qr_width, qr_height) / max(1.0, qr_size)
    registration_confidence = 45.0 + 15.0 * min(1.0, side_ratio)
    placement = {
        "detected": True,
        "acceptable": True,
        "confidence": round(registration_confidence, 2),
        "registrationConfidence": round(registration_confidence, 2),
        "projectedBubbleVisibility": round(visible_fraction, 4),
        "questionsOutsideFrame": questions_outside,
        "locator": "qr-anchor-lattice",
        "qrAnchorPresent": True,
        "qrAnchor": [
            [round(float(x), 3), round(float(y), 3)] for x, y in qr
        ],
        "outlineRequired": False,
        "templateId": template["id"],
        "templateRowStart": round(template_row_start, 4),
        "templateRowSpacing": round(template_row_spacing, 4),
        "provisionalContent": {
            "method": "fixed-qr-anchor-with-ring-lattice-validation",
        },
        "canonicalSize": [CANONICAL_WIDTH, CANONICAL_HEIGHT],
        "perspectiveTransform": [
            [round(float(value), 8) for value in row]
            for row in source_to_canonical
        ],
    }
    return [(warped, placement)]


def _qr_bounded_static_content_roi(
    gray: np.ndarray,
    qr_anchor: Optional[Sequence[Sequence[float]]],
) -> Optional[Tuple[np.ndarray, Tuple[int, int], Dict[str, Any]]]:
    """Return the complete form region inferred from a verified footer QR.

    Wide Pi frames can make the narrow answer sheet less than one quarter of
    the image width.  Detecting SIFT features on the full desk then spends the
    feature budget on wood grain while the fixed question print is reduced to
    only a few pixels.  The QR is used only to bound a generous search crop;
    the registration homography still has to come from immutable form print
    across both answer blocks and pass the full current-sheet lattice gates.
    """

    if qr_anchor is None:
        return None
    try:
        qr = np.asarray(qr_anchor, dtype=np.float32).reshape(4, 2)
    except (TypeError, ValueError):
        return None
    if not np.isfinite(qr).all():
        return None
    height, width = gray.shape
    qr_left = float(qr[:, 0].min())
    qr_right = float(qr[:, 0].max())
    qr_top = float(qr[:, 1].min())
    qr_bottom = float(qr[:, 1].max())
    qr_width = qr_right - qr_left
    qr_height = qr_bottom - qr_top
    qr_size = max(qr_width, qr_height)
    if (
        qr_size < 18.0
        or min(qr_width, qr_height) < qr_size * 0.58
        or qr_left < -2.0
        or qr_right > width + 2.0
        or qr_top < -2.0
        or qr_bottom > height + 2.0
    ):
        return None

    left = max(0, round(qr_left - 1.75 * qr_width))
    right = min(width, round(qr_right + 4.25 * qr_width))
    top = max(0, round(qr_top - 13.5 * qr_width))
    bottom = min(height, round(qr_bottom + 1.25 * qr_width))
    if right - left < 150 or bottom - top < 320:
        return None
    return gray[top:bottom, left:right], (left, top), {
        "method": "verified-qr-bounded-static-content-roi",
        "bounds": [left, top, right, bottom],
        "qrAnchorPresent": True,
        "clippedEdges": [
            edge
            for edge, touched in (
                ("top", top == 0),
                ("right", right == width),
                ("bottom", bottom == height),
                ("left", left == 0),
            )
            if touched
        ],
    }


def _oriented_paper_content(gray: np.ndarray) -> Optional[Tuple[np.ndarray, np.ndarray, Dict[str, Any]]]:
    """Crop the long paper axis before matching immutable print.

    The rectangle only bounds/resamples the search. It never establishes
    question identity: the usual feature, visibility and full-grid gates do.
    """
    scale = min(1.0, 800.0 / max(gray.shape))
    small = cv2.resize(gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    _, bright = cv2.threshold(cv2.GaussianBlur(small, (5, 5), 0), 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    bright = cv2.morphologyEx(bright, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
    contours, _ = cv2.findContours(bright, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    for contour in sorted(contours, key=cv2.contourArea, reverse=True)[:8]:
        area = cv2.contourArea(contour)
        if area < small.size * 0.035 or area > small.size * 0.70:
            continue
        rect = cv2.minAreaRect(contour)
        short, long = sorted(rect[1])
        if not (0.18 <= short / max(1.0, long) <= 0.58
                and long >= max(small.shape) * 0.38
                and area / max(1.0, short * long) >= 0.65):
            continue
        quad = _order_quad(cv2.boxPoints(rect)) / scale
        width, height = _quad_dimensions(quad)
        if width > height:
            quad = np.roll(quad, -1, axis=0)
            width, height = height, width
        center = quad.mean(axis=0)
        quad = center + (quad - center) * 1.12
        width, height = max(80, round(width * 1.12)), max(240, round(height * 1.12))
        transform = cv2.getPerspectiveTransform(quad.astype(np.float32), np.float32([[0,0],[width-1,0],[width-1,height-1],[0,height-1]]))
        content = cv2.warpPerspective(gray, transform, (width, height), borderValue=40)
        axis = quad[3] - quad[0]
        tilt = math.degrees(math.atan2(abs(float(axis[0])), abs(float(axis[1]))))
        return content, transform, {"method": "oriented-paper-content", "sourceCorners": quad.tolist(), "axisTiltDeg": tilt}
    # A patterned or glossy surface can join the white page to a much larger
    # Otsu component, especially when the top/bottom paper edges are outside
    # the frame. Estimate the sheet axis from the repeated printed rings
    # instead. Only the search crop is selected here: SIFT registration and
    # the complete 50x4 lattice still have to prove the sheet downstream.
    height, width = gray.shape
    if height < 300 or width < 500:
        return None
    ring_scale = min(1.0, 1440.0 / max(gray.shape))
    ring_image = (
        cv2.resize(
            gray,
            None,
            fx=ring_scale,
            fy=ring_scale,
            interpolation=cv2.INTER_AREA,
        )
        if ring_scale < 1.0
        else gray
    )
    ring_short = min(ring_image.shape)
    ring_blur = cv2.GaussianBlur(ring_image, (3, 3), 0)
    rings = cv2.HoughCircles(
        ring_blur,
        cv2.HOUGH_GRADIENT,
        dp=1.1,
        minDist=max(7, round(ring_short * 0.0105)),
        param1=80,
        param2=18,
        minRadius=max(3, round(ring_short * 0.0035)),
        maxRadius=max(8, round(ring_short * 0.015)),
    )
    if rings is None or rings.shape[1] < 80:
        return None
    ring_values = rings[0]
    # Cap pathological non-sheet scenes before the pairwise calculation.
    if len(ring_values) > 700:
        ring_values = ring_values[:700]
    ring_points = ring_values[:, :2].astype(np.float32)
    median_radius = float(np.median(ring_values[:, 2]))
    pair_delta = ring_points[:, None, :] - ring_points[None, :, :]
    pair_distance = np.sqrt(np.sum(pair_delta * pair_delta, axis=2))
    neighbor_min = max(7.0, median_radius * 1.55)
    neighbor_max = min(ring_short * 0.075, median_radius * 4.5)
    neighbor_mask = (
        (pair_distance >= neighbor_min)
        & (pair_distance <= neighbor_max)
    )
    if int(np.count_nonzero(neighbor_mask)) < 120:
        return None
    pair_angles = (
        np.degrees(
            np.arctan2(pair_delta[:, :, 1], pair_delta[:, :, 0])
        )
        % 90.0
    )
    histogram, edges = np.histogram(
        pair_angles[neighbor_mask], bins=180, range=(0.0, 90.0)
    )
    # Smooth circularly because an upright grid straddles 0/90 degrees.
    extended = np.concatenate((histogram[-3:], histogram, histogram[:3]))
    smoothed_histogram = np.convolve(
        extended, np.asarray([1, 2, 3, 4, 3, 2, 1]), mode="valid"
    )
    peak_index = int(np.argmax(smoothed_histogram))
    peak_support = int(smoothed_histogram[peak_index])
    raw_peak_support = int(histogram.max())
    if raw_peak_support < 24 or peak_support < 90:
        return None
    axis_angle = float((edges[peak_index] + edges[peak_index + 1]) * 0.5)
    if axis_angle > 45.0:
        axis_angle -= 90.0
    # The measured short-axis angle selects a search crop. Printed-template
    # verification, rather than the ring direction, establishes identity.
    center = (width * 0.5, height * 0.5)
    affine = cv2.getRotationMatrix2D(center, axis_angle, 1.0)
    rotated = cv2.warpAffine(
        gray,
        affine,
        (width, height),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=int(np.median(gray)),
    )
    paper_band = _vertical_paper_band_roi(rotated)
    if paper_band is None:
        return None
    content, (left, top), band_details = paper_band
    source_to_rotated = np.asarray(
        [
            [float(affine[0, 0]), float(affine[0, 1]), float(affine[0, 2])],
            [float(affine[1, 0]), float(affine[1, 1]), float(affine[1, 2])],
            [0.0, 0.0, 1.0],
        ],
        dtype=np.float64,
    )
    rotated_to_content = np.asarray(
        [[1.0, 0.0, -left], [0.0, 1.0, -top], [0.0, 0.0, 1.0]],
        dtype=np.float64,
    )
    details = dict(band_details)
    details.update({
        "method": "answer-ring-axis-content",
        "axisTiltDeg": round(abs(axis_angle), 3),
        "deskewCorrectionDeg": round(axis_angle, 3),
        "ringAxisCandidates": int(len(ring_values)),
        "ringAxisPeakSupport": raw_peak_support,
    })
    return content, rotated_to_content @ source_to_rotated, details


def _ring_lattice_registration_candidates(
    gray: np.ndarray,
    prepared_content: Tuple[np.ndarray, np.ndarray, Dict[str, Any]],
) -> List[Tuple[np.ndarray, Dict[str, Any]]]:
    """Register a deskewed, borderless sheet from its complete ring lattice."""

    content, source_to_content, content_details = prepared_content
    height, width = content.shape
    if height < 300 or width < 180:
        return []
    blurred = cv2.GaussianBlur(content, (3, 3), 0)
    ring_short = min(content.shape)
    rings = cv2.HoughCircles(
        blurred,
        cv2.HOUGH_GRADIENT,
        dp=1.1,
        minDist=max(7, round(ring_short * 0.014)),
        param1=80,
        param2=17,
        minRadius=max(3, round(ring_short * 0.006)),
        maxRadius=max(9, round(ring_short * 0.026)),
    )
    if rings is None or rings.shape[1] < 100:
        return []
    values = rings[0]
    points = values[:, :2].astype(np.float32)
    median_radius = float(np.median(values[:, 2]))

    def density(values_1d: np.ndarray, length: int, radius: int) -> np.ndarray:
        histogram = np.zeros(length, dtype=np.float32)
        positions = np.clip(
            np.rint(values_1d).astype(np.int32), 0, length - 1
        )
        np.add.at(histogram, positions, 1.0)
        return np.convolve(
            histogram,
            np.ones(radius * 2 + 1, dtype=np.float32),
            mode="same",
        )

    # Find the two four-lane blocks before fitting rows. This removes QR
    # modules, question-number glyphs, and circular desk patterns from the
    # vertical projection.
    x_density = density(points[:, 0], width, 4)
    group_candidates: List[Tuple[float, float, float, int]] = []
    minimum_choice_spacing = max(11.0, median_radius * 1.75)
    maximum_choice_spacing = min(46.0, width * 0.11)
    for spacing in np.arange(
        minimum_choice_spacing, maximum_choice_spacing + 0.01, 0.25
    ):
        maximum_start = int(math.floor(width - 1 - 3.0 * spacing))
        if maximum_start < 0:
            continue
        offsets = np.arange(4, dtype=np.float32) * spacing
        for start in range(maximum_start + 1):
            locations = np.rint(start + offsets).astype(np.int32)
            support = x_density[locations]
            covered = int(np.count_nonzero(support >= 8.0))
            if covered < 3:
                continue
            score = float(np.minimum(support, 35.0).sum() + covered * 5.0)
            group_candidates.append(
                (score, float(start), float(spacing), covered)
            )
    if len(group_candidates) < 2:
        return []
    group_candidates.sort(reverse=True)
    group_candidates = group_candidates[:500]
    best_pair: Optional[
        Tuple[float, Tuple[float, float, float, int], Tuple[float, float, float, int]]
    ] = None
    for first in group_candidates:
        for second in group_candidates:
            left, right = (
                (first, second) if first[1] < second[1] else (second, first)
            )
            separation = right[1] - left[1]
            mean_spacing = (left[2] + right[2]) * 0.5
            spacing_ratio = min(left[2], right[2]) / max(left[2], right[2])
            if (
                separation < mean_spacing * 5.0
                or separation > width * 0.72
                or spacing_ratio < 0.72
            ):
                continue
            score = left[0] + right[0] + spacing_ratio * 25.0
            if best_pair is None or score > best_pair[0]:
                best_pair = (score, left, right)
    if best_pair is None:
        return []
    _, left_group, right_group = best_pair

    lane_near = np.zeros(len(points), dtype=bool)
    for group in (left_group, right_group):
        _, group_start, choice_spacing, _ = group
        x_tolerance = max(4.0, choice_spacing * 0.30)
        for lane in range(4):
            lane_near |= (
                np.abs(
                    points[:, 0]
                    - (group_start + lane * choice_spacing)
                )
                <= x_tolerance
            )
    row_points = points[lane_near]
    if len(row_points) < 90:
        return []

    # Perspective makes row spacing grow or shrink from top to bottom. A
    # quadratic row profile is an accurate bounded approximation of that
    # projective change and avoids locking onto a shorter harmonic sequence.
    y_density = density(row_points[:, 1], height, 3)
    row_numbers = np.arange(25, dtype=np.float32)
    best_rows: Optional[
        Tuple[float, float, float, float, int, np.ndarray]
    ] = None
    for first_spacing in np.arange(11.0, 31.01, 0.5):
        for curvature in np.arange(-0.28, 0.281, 0.01):
            offsets = (
                first_spacing * row_numbers
                + curvature * row_numbers * row_numbers
            )
            span = float(offsets[-1])
            if span < height * 0.34 or span > height * 0.88:
                continue
            maximum_start = int(math.floor(height - 1 - span))
            starts = np.arange(maximum_start + 1, dtype=np.float32)
            locations = np.rint(
                starts[:, None] + offsets[None, :]
            ).astype(np.int32)
            support = y_density[locations]
            covered = np.count_nonzero(support >= 3.0, axis=1)
            scores = (
                np.minimum(support, 9.0).sum(axis=1)
                + covered.astype(np.float32) * 3.0
            )
            best_index = int(np.argmax(scores))
            score = float(scores[best_index])
            if best_rows is None or score > best_rows[0]:
                start = float(starts[best_index])
                best_rows = (
                    score,
                    start,
                    float(first_spacing),
                    float(curvature),
                    int(covered[best_index]),
                    start + offsets,
                )
    if best_rows is None or best_rows[4] < 22:
        return []
    _, row_start, first_row_spacing, row_curvature, covered_rows, row_positions = (
        best_rows
    )
    row_spacing = float(np.median(np.diff(row_positions)))

    templates = _load_registration_templates()
    template = next(
        (item for item in templates if item.get("primary")),
        templates[0] if templates else None,
    )
    if template is None:
        return []
    template_centers = np.asarray(
        template["centers"], dtype=np.float32
    ).reshape(50, 4, 2)
    seed_source: List[List[float]] = []
    seed_target: List[np.ndarray] = []
    for block, group in enumerate((left_group, right_group)):
        _, group_start, choice_spacing, _ = group
        for row, row_y in enumerate(row_positions):
            for lane in range(4):
                seed_source.append([
                    group_start + lane * choice_spacing,
                    float(row_y),
                ])
                seed_target.append(template_centers[block * 25 + row, lane])
    seed_homography, _ = cv2.findHomography(
        np.asarray(seed_source, dtype=np.float32),
        np.asarray(seed_target, dtype=np.float32),
        0,
    )
    if seed_homography is None:
        return []
    projected_points = cv2.perspectiveTransform(
        points.reshape(-1, 1, 2), seed_homography
    ).reshape(-1, 2)
    flat_template_centers = template_centers.reshape(-1, 2)
    cell_matches: Dict[Tuple[int, int], Tuple[float, np.ndarray]] = {}
    for point, projected_point in zip(points, projected_points):
        distances = np.linalg.norm(
            flat_template_centers - projected_point, axis=1
        )
        flat_index = int(np.argmin(distances))
        residual = float(distances[flat_index])
        if residual > 24.0:
            continue
        question, lane = divmod(flat_index, 4)
        key = (question, lane)
        previous = cell_matches.get(key)
        if previous is None or residual < previous[0]:
            cell_matches[key] = (residual, point)
    if len(cell_matches) < 105:
        return []
    source_points = np.asarray(
        [value[1] for value in cell_matches.values()], dtype=np.float32
    )
    target_points = np.asarray(
        [template_centers[key[0], key[1]] for key in cell_matches],
        dtype=np.float32,
    )
    # The seed has already established the absolute row and A-D lane identity.
    # Fit all seed-bounded correspondences together so a consensus estimator
    # cannot prefer one 25x4 block and shift the other by one repeated lane.
    content_to_canonical, _ = cv2.findHomography(
        source_points,
        target_points,
        0,
    )
    if content_to_canonical is None:
        return []
    projected_matches = cv2.perspectiveTransform(
        source_points.reshape(-1, 1, 2), content_to_canonical
    ).reshape(-1, 2)
    match_errors = np.linalg.norm(projected_matches - target_points, axis=1)
    inliers = match_errors <= 20.0
    inlier_count = int(inliers.sum())
    if inlier_count < 85:
        return []
    content_to_canonical, _ = cv2.findHomography(
        source_points[inliers],
        target_points[inliers],
        0,
    )
    if content_to_canonical is None:
        return []
    seed_projection = cv2.perspectiveTransform(
        np.asarray(seed_source, dtype=np.float32).reshape(-1, 1, 2),
        content_to_canonical,
    ).reshape(2, 25, 4, 2)
    seed_targets = np.asarray(seed_target, dtype=np.float32).reshape(
        2, 25, 4, 2
    )
    block_alignment_errors = [
        float(np.median(np.linalg.norm(
            seed_projection[block] - seed_targets[block], axis=2
        )))
        for block in range(2)
    ]
    canonical_choice_spacing = float(np.median(
        np.linalg.norm(
            template_centers[:, 1:, :] - template_centers[:, :-1, :],
            axis=2,
        )
    ))
    # Allow perspective-model residual below three-fifths of one lane while
    # rejecting a full repeated-lane slip (approximately one lane).
    if max(block_alignment_errors) > canonical_choice_spacing * 0.60:
        return []
    inlier_keys = [
        key for key, is_inlier in zip(cell_matches, inliers) if bool(is_inlier)
    ]
    row_support = len({key[0] for key in inlier_keys})
    lane_support = [
        sum(1 for key in inlier_keys if key[1] == lane)
        for lane in range(4)
    ]
    edge_support = sum(
        1 for key in inlier_keys if key[0] in (0, 24, 25, 49)
    )
    # One complete 25x4 block is enough to seed a projective warp. Acceptance
    # still requires both current-sheet blocks and all 50 rows in
    # _evaluate_registered_sheet below.
    if row_support < 25 or min(lane_support) < 14 or edge_support < 5:
        return []
    source_to_canonical = (
        np.asarray(content_to_canonical, dtype=np.float64)
        @ np.asarray(source_to_content, dtype=np.float64)
    )
    try:
        canonical_to_source = np.linalg.inv(source_to_canonical)
    except np.linalg.LinAlgError:
        return []
    projected_bubbles = cv2.perspectiveTransform(
        template["centers"].reshape(-1, 1, 2),
        canonical_to_source,
    ).reshape(-1, 2)
    visible = (
        (projected_bubbles[:, 0] >= 4)
        & (projected_bubbles[:, 0] < gray.shape[1] - 4)
        & (projected_bubbles[:, 1] >= 4)
        & (projected_bubbles[:, 1] < gray.shape[0] - 4)
    )
    visible_fraction = float(np.mean(visible))
    if visible_fraction < 0.96:
        return []
    warped = cv2.warpPerspective(
        gray,
        source_to_canonical,
        (CANONICAL_WIDTH, CANONICAL_HEIGHT),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=255,
    )
    registration_confidence = min(
        92.0,
        48.0
        + 24.0 * min(1.0, inlier_count / 150.0)
        + 10.0 * min(1.0, row_support / 50.0)
        + 8.0 * visible_fraction,
    )
    placement = {
        "detected": True,
        "acceptable": True,
        "confidence": round(registration_confidence, 2),
        "registrationConfidence": round(registration_confidence, 2),
        "locator": "answer-ring-lattice",
        "outlineRequired": False,
        "templateId": template["id"],
        "templateRowStart": round(
            float(np.mean(template_centers[[0, 25], :, 1])), 4
        ),
        "templateRowSpacing": round(
            float(np.median(np.diff(template_centers[:25, :, 1].mean(axis=1)))),
            4,
        ),
        "ringMatches": len(cell_matches),
        "ringInliers": inlier_count,
        "blockAlignmentErrors": [
            round(value, 3) for value in block_alignment_errors
        ],
        "rowSupport": row_support,
        "laneSupport": lane_support,
        "edgeCellSupport": edge_support,
        "projectedBubbleVisibility": round(visible_fraction, 4),
        "questionsOutsideFrame": [],
        "provisionalContent": {
            key: value
            for key, value in content_details.items()
            if not str(key).startswith("_")
        },
        "canonicalSize": [CANONICAL_WIDTH, CANONICAL_HEIGHT],
        "perspectiveTransform": [
            [round(float(value), 8) for value in row]
            for row in source_to_canonical
        ],
    }
    return [(warped, placement)]


def _feature_registration_candidates(
    gray: np.ndarray,
    debug_dir: Optional[Path] = None,
    qr_anchor: Optional[Sequence[Sequence[float]]] = None,
    rotation_margin_ratio: Optional[float] = None,
    prepared_content: Optional[Tuple[np.ndarray, np.ndarray, Dict[str, Any]]] = None,
) -> List[Tuple[np.ndarray, Dict[str, Any]]]:
    """Register a partial camera frame directly to immutable form content."""

    templates = _load_registration_templates()
    if not templates:
        raise OmrRejected(
            "Answer sheet boundary was not found and the fixed-template registrar is unavailable",
            {
                "stage": "template-registration",
                "outlineRequired": False,
                "templateManifest": str(REGISTRATION_MANIFEST_PATH),
                "templateLoadError": _REGISTRATION_TEMPLATE_ERROR,
                "recommendation": (
                    "Install the versioned AcadCheck registration-template assets "
                    "or scan a frame containing more of the fixed question-number print."
                ),
            },
        )
    if not hasattr(cv2, "SIFT_create"):
        raise OmrRejected(
            "This OpenCV build does not provide the SIFT template registrar",
            {
                "stage": "template-registration",
                "outlineRequired": False,
                "recommendation": "Install OpenCV 4.8+ with SIFT support.",
            },
        )

    qr_content = _qr_bounded_static_content_roi(gray, qr_anchor)
    high_detail_registration = qr_content is not None
    if prepared_content is not None:
        content, _source_to_content, content_details = prepared_content
        content_offset = (0, 0)
        high_detail_registration = True
        scale = min(2.0, 1400.0 / max(content.shape))
    elif qr_content is not None:
        content, content_offset, content_details = qr_content
        # Upscale a narrow distant form so question numbers and ring edges
        # occupy enough pixels for stable descriptors.  The crop keeps this
        # bounded to roughly the same work as the former full-frame pass.
        scale = min(2.0, 1400.0 / max(content.shape))
    else:
        content, content_offset, content_details = _provisional_content_roi(
            gray, rotation_margin_ratio
        )
        content_height, content_width = content.shape
        # A freely placed sheet can fill the camera height while occupying
        # less than half of a landscape frame.  The old no-QR path then
        # capped that already-small crop at 1,000 pixels and never enlarged
        # it, leaving question numbers and bubble rings too small for stable
        # fixed-print descriptors.  Detect this geometry from the bright
        # paper ROI itself and upscale only that bounded crop; no QR pixels or
        # decoded QR payload participate in registration.
        high_detail_registration = (
            content_height >= content_width * 1.45
            and content_width <= gray.shape[1] * 0.62
        )
        scale = (
            min(2.0, 1400.0 / max(content.shape))
            if high_detail_registration
            else min(1.0, 1000.0 / max(content.shape))
        )
    if abs(scale - 1.0) > 0.01:
        small = cv2.resize(
            content,
            None,
            fx=scale,
            fy=scale,
            interpolation=(
                cv2.INTER_CUBIC if scale > 1.0 else cv2.INTER_AREA
            ),
        )
    else:
        small = content
    detector = cv2.SIFT_create(
        # The fixed-print mask produces many near-duplicate glyph features.
        # Keeping the strongest 1,800 preserves the two-block/y-span gates
        # while reducing descriptor extraction and six-template matching
        # work on the normal no-QR registration path.
        nfeatures=3500 if high_detail_registration else 1800,
        contrastThreshold=0.012,
        edgeThreshold=16,
    )
    target_keypoints, target_descriptors = detector.detectAndCompute(
        small, None
    )
    if debug_dir is not None:
        keypoint_view = cv2.drawKeypoints(
            small,
            target_keypoints or [],
            None,
            color=(0, 180, 255),
            flags=cv2.DRAW_MATCHES_FLAGS_DRAW_RICH_KEYPOINTS,
        )
        _debug_write(
            debug_dir,
            "01a_detected_camera_keypoints",
            keypoint_view,
        )
    if target_descriptors is None or len(target_keypoints) < 40:
        no_print_evidence = len(target_keypoints) < 8
        raise OmrRejected(
            "Not enough fixed answer-sheet print is visible for registration",
            {
                "stage": "feature-detection",
                "keypoints": len(target_keypoints),
                "requiredKeypoints": 40,
                "outlineRequired": False,
                "sheetPresence": (
                    "absent" if no_print_evidence else "indeterminate"
                ),
                "answerContentDetected": (
                    False if no_print_evidence else None
                ),
                "presenceConfidence": round(
                    max(0.0, 100.0 - len(target_keypoints) * 4.0),
                    2,
                ) if no_print_evidence else 0.0,
                "recommendation": (
                    "Keep the complete answer area visible and improve focus or lighting."
                ),
            },
        )

    target_points_all = np.asarray(
        [keypoint.pt for keypoint in target_keypoints], dtype=np.float32
    )
    matcher = cv2.BFMatcher(cv2.NORM_L2)
    raw_candidates: List[Dict[str, Any]] = []
    rejected_candidates: List[Dict[str, Any]] = []
    best_ratio_match_count = 0
    best_homography_inliers = 0
    required_registration_confidence = SIFT_MIN_REGISTRATION_CONFIDENCE
    source_to_small = np.asarray(
        [
            [scale, 0.0, -scale * content_offset[0]],
            [0.0, scale, -scale * content_offset[1]],
            [0.0, 0.0, 1.0],
        ],
        dtype=np.float64,
    )
    if prepared_content is not None:
        source_to_small = np.diag([scale, scale, 1.0]) @ prepared_content[1]
    for template in templates:
        pairs = matcher.knnMatch(
            template["descriptors"], target_descriptors, k=2
        )
        ratio_matches = [
            first
            for pair in pairs
            if len(pair) == 2
            for first, second in [pair]
            if first.distance
            < (0.86 if qr_content is not None else 0.80)
            * second.distance
        ]
        # A single target keypoint must not vote for several repeated question
        # glyphs.  Keep its best descriptor correspondence only.
        unique_matches: Dict[int, Any] = {}
        for match in sorted(ratio_matches, key=lambda value: value.distance):
            unique_matches.setdefault(match.trainIdx, match)
        matches = list(unique_matches.values())
        best_ratio_match_count = max(
            best_ratio_match_count, len(matches)
        )
        if len(matches) < 8:
            continue
        template_points = np.asarray(
            [template["points"][match.queryIdx] for match in matches],
            dtype=np.float32,
        )
        target_points = np.asarray(
            [target_points_all[match.trainIdx] for match in matches],
            dtype=np.float32,
        )
        cv2.setRNGSeed(1937)
        homography, inlier_mask = cv2.findHomography(
            template_points,
            target_points,
            cv2.USAC_MAGSAC,
            4.0,
        )
        if homography is None or inlier_mask is None:
            continue
        inliers = inlier_mask.reshape(-1).astype(bool)
        inlier_count = int(inliers.sum())
        best_homography_inliers = max(
            best_homography_inliers, inlier_count
        )
        # Distant 1440px camera frames can leave only 6-7 distinctive
        # question-number/header matches after a modest sheet rotation. Do
        # not discard those homographies before the strict projection,
        # two-block support, reprojection, and complete 50x4 bubble-lattice
        # validators below have a chance to prove the current sheet.
        if inlier_count < 6:
            continue
        inlier_template = template_points[inliers]
        inlier_target = target_points[inliers]
        projected = cv2.perspectiveTransform(
            inlier_template.reshape(-1, 1, 2), homography
        ).reshape(-1, 2)
        errors = np.linalg.norm(projected - inlier_target, axis=1)
        median_error = float(np.median(errors))
        y_span = float(np.ptp(inlier_template[:, 1]))
        left_support = int(np.sum(inlier_template[:, 0] < 300))
        right_support = int(np.sum(inlier_template[:, 0] > 400))
        projected_bubbles = cv2.perspectiveTransform(
            template["centers"].reshape(-1, 1, 2), homography
        ).reshape(-1, 2)
        inside = (
            (projected_bubbles[:, 0] >= 5)
            & (projected_bubbles[:, 0] < small.shape[1] - 5)
            & (projected_bubbles[:, 1] >= 5)
            & (projected_bubbles[:, 1] < small.shape[0] - 5)
        )
        visible_fraction = float(np.mean(inside))
        visible_rows = inside.reshape(50, 4).all(axis=1)
        questions_outside = [
            int(index + 1)
            for index, visible in enumerate(visible_rows)
            if not bool(visible)
        ]
        inlier_ratio = inlier_count / max(1, len(matches))
        count_score = min(1.0, inlier_count / 42.0)
        ratio_score = min(1.0, inlier_ratio / 0.34)
        span_score = min(1.0, y_span / 1350.0)
        block_score = min(
            1.0, min(left_support, right_support) / 7.0
        )
        unilateral_static_support = (
            inlier_count >= 24
            and y_span >= 1100
            and max(left_support, right_support) >= 20
        )
        if unilateral_static_support:
            block_score = max(block_score, 0.55)
        error_score = max(0.0, 1.0 - median_error / 3.5)
        feature_confidence = 100.0 * (
            0.30 * count_score
            + 0.17 * ratio_score
            + 0.20 * span_score
            + 0.14 * block_score
            + 0.12 * error_score
            + 0.07 * visible_fraction
        )
        failed_gates: List[Dict[str, Any]] = []
        if inlier_count < 6:
            failed_gates.append({
                "gate": "minimum-inlier-count",
                "observed": inlier_count,
                "requiredMinimum": 6,
            })
        if y_span < 620:
            failed_gates.append({
                "gate": "minimum-template-y-span",
                "observed": round(y_span, 3),
                "requiredMinimum": 620.0,
            })
        if (
            min(left_support, right_support) < 2
            and not unilateral_static_support
        ):
            failed_gates.append({
                "gate": "static-support-distribution",
                "observed": {
                    "left": left_support,
                    "right": right_support,
                    "unilateralSupportQualified": False,
                },
                "requirement": (
                    "At least 2 inliers on each answer block, or the "
                    "strong unilateral-support recovery gate"
                ),
            })
        if visible_fraction < 0.96:
            failed_gates.append({
                "gate": "projected-bubble-visibility",
                "observed": round(visible_fraction, 4),
                "requiredMinimum": 0.96,
                "questionsOutsideFrame": questions_outside,
            })
        if median_error > 4.0:
            failed_gates.append({
                "gate": "maximum-median-reprojection-error",
                "observed": round(median_error, 4),
                "requiredMaximum": 4.0,
            })
        observation = {
            "template": template,
            "homography": homography,
            "templatePoints": template_points,
            "targetPoints": target_points,
            "inliers": inliers,
            "featureConfidence": feature_confidence,
            "featureMatches": len(matches),
            "inlierCount": inlier_count,
            "inlierRatio": inlier_ratio,
            "medianReprojectionError": median_error,
            "templateYSpan": y_span,
            "leftStaticSupport": left_support,
            "rightStaticSupport": right_support,
            "projectedBubbleVisibility": visible_fraction,
            "questionsOutsideFrame": questions_outside,
            "failedGates": failed_gates,
        }
        if failed_gates:
            rejected_candidates.append(observation)
            continue
        source_to_canonical = np.linalg.inv(homography) @ source_to_small
        warped = cv2.warpPerspective(
            gray,
            source_to_canonical,
            (CANONICAL_WIDTH, CANONICAL_HEIGHT),
            flags=cv2.INTER_LINEAR,
            borderMode=cv2.BORDER_CONSTANT,
            borderValue=255,
        )
        alignment_error = _static_alignment_error(warped, template)
        alignment_confidence = 100.0 * math.exp(
            -alignment_error / 4.0
        )
        registration_confidence = (
            0.78 * feature_confidence
            + 0.22 * alignment_confidence
        )
        candidate = {
            "warped": warped,
            "template": template,
            "homography": homography,
            "sourceToCanonical": source_to_canonical,
            "templatePoints": template_points,
            "targetPoints": target_points,
            "inliers": inliers,
            "placement": {
                "detected": True,
                "acceptable": (
                    registration_confidence
                    >= required_registration_confidence
                ),
                "confidence": round(registration_confidence, 2),
                "registrationConfidence": round(
                    registration_confidence, 2
                ),
                "templateAlignmentError": round(alignment_error, 4),
                "featureConfidence": round(feature_confidence, 2),
                "alignmentConfidence": round(alignment_confidence, 2),
                "featureMatches": len(matches),
                "inliers": inlier_count,
                "inlierRatio": round(inlier_ratio, 4),
                "medianReprojectionError": round(median_error, 4),
                "templateYSpan": round(y_span, 3),
                "leftStaticSupport": left_support,
                "rightStaticSupport": right_support,
                "projectedBubbleVisibility": round(
                    visible_fraction, 4
                ),
                "questionsOutsideFrame": questions_outside,
                "locator": "sift-static-template-usac",
                "outlineRequired": False,
                "templateId": template["id"],
                "templateRowStart": round(
                    float(
                        np.median(
                            template["centers"][
                                np.asarray([0, 25]), :, 1
                            ]
                        )
                    ),
                    4,
                ),
                "templateRowSpacing": round(
                    float(
                        np.median(
                            np.concatenate((
                                np.diff(
                                    template["centers"][
                                        :25, :, 1
                                    ].mean(axis=1)
                                ),
                                np.diff(
                                    template["centers"][
                                        25:, :, 1
                                    ].mean(axis=1)
                                ),
                            ))
                        )
                    ),
                    4,
                ),
                "provisionalContent": content_details,
                "canonicalSize": [
                    CANONICAL_WIDTH,
                    CANONICAL_HEIGHT,
                ],
                "perspectiveTransform": [
                    [round(float(value), 8) for value in row]
                    for row in source_to_canonical
                ],
            },
        }
        if registration_confidence < required_registration_confidence:
            candidate.update(observation)
            candidate["sourceToCanonical"] = source_to_canonical
            candidate["warped"] = warped
            candidate["alignmentError"] = alignment_error
            candidate["alignmentConfidence"] = alignment_confidence
            candidate["registrationConfidence"] = (
                registration_confidence
            )
            candidate["failedGates"] = [{
                "gate": "minimum-registration-confidence",
                "observed": round(registration_confidence, 2),
                "requiredMinimum": required_registration_confidence,
            }]
            rejected_candidates.append(candidate)
            continue
        raw_candidates.append(candidate)
        # The pre-aligned ensemble is the normal fixed-template path.  A
        # strong primary match avoids five unnecessary descriptor searches;
        # the source references remain a bounded recovery ensemble for weak
        # print, crop, or lighting cases.
        if (
            template.get("primary")
            and inlier_count >= 25
            and registration_confidence >= 78.0
            and alignment_error <= 1.25
            and y_span >= 1100
            and min(left_support, right_support) >= 3
        ):
            break
    if not raw_candidates:
        if rejected_candidates:
            best_rejected = max(
                rejected_candidates,
                key=lambda candidate: (
                    -len(candidate.get("failedGates") or []),
                    float(candidate.get("featureConfidence", 0.0)),
                    int(candidate.get("inlierCount", 0)),
                    -float(
                        candidate.get(
                            "medianReprojectionError", float("inf")
                        )
                    ),
                ),
            )
            if "sourceToCanonical" not in best_rejected:
                source_to_canonical = (
                    np.linalg.inv(best_rejected["homography"])
                    @ source_to_small
                )
                warped = cv2.warpPerspective(
                    gray,
                    source_to_canonical,
                    (CANONICAL_WIDTH, CANONICAL_HEIGHT),
                    flags=cv2.INTER_LINEAR,
                    borderMode=cv2.BORDER_CONSTANT,
                    borderValue=255,
                )
                alignment_error = _static_alignment_error(
                    warped, best_rejected["template"]
                )
                alignment_confidence = 100.0 * math.exp(
                    -alignment_error / 4.0
                )
                registration_confidence = (
                    0.78
                    * float(best_rejected["featureConfidence"])
                    + 0.22 * alignment_confidence
                )
                best_rejected.update({
                    "sourceToCanonical": source_to_canonical,
                    "warped": warped,
                    "alignmentError": alignment_error,
                    "alignmentConfidence": alignment_confidence,
                    "registrationConfidence": registration_confidence,
                })
                if (
                    registration_confidence
                    < required_registration_confidence
                    and not any(
                        gate.get("gate")
                        == "minimum-registration-confidence"
                        for gate in best_rejected["failedGates"]
                    )
                ):
                    best_rejected["failedGates"].append({
                        "gate": "minimum-registration-confidence",
                        "observed": round(
                            registration_confidence, 2
                        ),
                        "requiredMinimum": (
                            required_registration_confidence
                        ),
                    })
            _write_feature_registration_debug(
                debug_dir,
                small,
                gray,
                best_rejected,
                rejected=True,
            )
            failed_gates = best_rejected["failedGates"]
            primary_gate = failed_gates[0]
            gate_name = primary_gate.get("gate")
            if gate_name == "projected-bubble-visibility":
                failure_reason = (
                    "Fixed-template registration rejected because projected "
                    f"bubble visibility was {100.0 * float(primary_gate['observed']):.1f}%; "
                    f"at least {100.0 * float(primary_gate['requiredMinimum']):.1f}% "
                    "is required"
                )
            elif gate_name == "minimum-registration-confidence":
                failure_reason = (
                    "Fixed-template registration confidence was "
                    f"{float(primary_gate['observed']):.2f}%; "
                    f"at least {float(primary_gate['requiredMinimum']):.2f}% "
                    "is required"
                )
            elif gate_name == "minimum-template-y-span":
                failure_reason = (
                    "Fixed-template registration rejected because too little "
                    "of the answer rows is visible"
                )
            elif gate_name == "static-support-distribution":
                failure_reason = (
                    "Fixed-template registration rejected because fixed print "
                    "support is insufficient across the answer blocks"
                )
            elif gate_name == "minimum-inlier-count":
                failure_reason = (
                    "Fixed-template registration rejected because too few "
                    "feature matches agree with one homography"
                )
            else:
                failure_reason = (
                    "Fixed-template registration rejected because alignment "
                    "error exceeds the allowed threshold"
                )
            raise OmrRejected(
                failure_reason,
                {
                    "stage": "template-registration",
                    "keypoints": len(target_keypoints),
                    "templatesChecked": len(templates),
                    "outlineRequired": False,
                    "registrationConfidence": round(
                        float(
                            best_rejected.get(
                                "registrationConfidence", 0.0
                            )
                        ),
                        2,
                    ),
                    "requiredRegistrationConfidence": (
                        required_registration_confidence
                    ),
                    "featureConfidence": round(
                        float(best_rejected["featureConfidence"]), 2
                    ),
                    "alignmentConfidence": round(
                        float(
                            best_rejected.get(
                                "alignmentConfidence", 0.0
                            )
                        ),
                        2,
                    ),
                    "templateAlignmentError": round(
                        float(
                            best_rejected.get(
                                "alignmentError", 20.0
                            )
                        ),
                        4,
                    ),
                    "featureMatches": int(
                        best_rejected["featureMatches"]
                    ),
                    "inliers": int(best_rejected["inlierCount"]),
                    "inlierRatio": round(
                        float(best_rejected["inlierRatio"]), 4
                    ),
                    "medianReprojectionError": round(
                        float(
                            best_rejected[
                                "medianReprojectionError"
                            ]
                        ),
                        4,
                    ),
                    "templateYSpan": round(
                        float(best_rejected["templateYSpan"]), 3
                    ),
                    "leftStaticSupport": int(
                        best_rejected["leftStaticSupport"]
                    ),
                    "rightStaticSupport": int(
                        best_rejected["rightStaticSupport"]
                    ),
                    "projectedBubbleVisibility": round(
                        float(
                            best_rejected[
                                "projectedBubbleVisibility"
                            ]
                        ),
                        4,
                    ),
                    "questionsOutsideFrame": best_rejected[
                        "questionsOutsideFrame"
                    ],
                    "failedRegistrationGates": failed_gates,
                    "failingGate": gate_name,
                    "templateId": best_rejected["template"]["id"],
                    "provisionalContent": content_details,
                    "sheetPresence": "present",
                    "answerContentDetected": True,
                    "presenceConfidence": round(
                        min(
                            99.0,
                            55.0
                            + 1.4
                            * float(best_rejected["inlierCount"]),
                        ),
                        2,
                    ),
                    "recommendation": (
                        "Keep both answer columns and the printed question "
                        "numbers visible; paper borders and corners are not "
                        "required."
                    ),
                },
            )
        no_template_evidence = (
            best_homography_inliers < 5
            and best_ratio_match_count < 12
        )
        raise OmrRejected(
            "No robust fixed-template homography could be estimated",
            {
                "stage": "template-registration",
                "keypoints": len(target_keypoints),
                "templatesChecked": len(templates),
                "outlineRequired": False,
                "requiredRegistrationConfidence": (
                    required_registration_confidence
                ),
                "bestFeatureMatches": best_ratio_match_count,
                "bestHomographyInliers": best_homography_inliers,
                "provisionalContent": content_details,
                "sheetPresence": (
                    "absent"
                    if no_template_evidence
                    else "indeterminate"
                ),
                "answerContentDetected": (
                    False if no_template_evidence else None
                ),
                "presenceConfidence": (
                    round(
                        min(
                            98.0,
                            78.0
                            + 2.0
                            * (
                                5 - best_homography_inliers
                            ),
                        ),
                        2,
                    )
                    if no_template_evidence
                    else 0.0
                ),
                "failedRegistrationGates": [{
                    "gate": "robust-homography",
                    "observed": "not-estimated",
                    "requirement": (
                        "At least 8 mutually consistent feature matches"
                    ),
                }],
                "failingGate": "robust-homography",
                "recommendation": (
                    "Keep both answer columns and the printed question numbers visible; "
                    "paper borders and corners are not required."
                ),
            },
        )
    raw_candidates.sort(
        key=lambda candidate: (
            candidate["placement"]["registrationConfidence"],
            candidate["placement"]["inliers"],
            -candidate["placement"]["templateAlignmentError"],
        ),
        reverse=True,
    )
    best = raw_candidates[0]
    _write_feature_registration_debug(
        debug_dir, small, gray, best
    )
    return [
        (candidate["warped"], candidate["placement"])
        for candidate in raw_candidates[:3]
    ]


def _tracking_key(options: Dict[str, Any]) -> Optional[str]:
    value = options.get("trackingSessionId")
    if not isinstance(value, str):
        return None
    value = value.strip()
    if not value or len(value) > 160:
        return None
    return value


def _tracking_frame_id(options: Dict[str, Any]) -> Optional[int]:
    value = options.get("frameId")
    if isinstance(value, bool):
        return None
    try:
        frame_id = int(value)
    except (TypeError, ValueError):
        return None
    return frame_id if frame_id >= 0 else None


def _tracking_small(gray: np.ndarray) -> Tuple[np.ndarray, float]:
    scale = min(1.0, 900.0 / max(gray.shape))
    if scale < 1.0:
        return (
            cv2.resize(
                gray,
                None,
                fx=scale,
                fy=scale,
                interpolation=cv2.INTER_AREA,
            ),
            scale,
        )
    return gray, 1.0


def _prune_tracking_cache(now: Optional[float] = None) -> None:
    now = now if now is not None else time.monotonic()
    expired = [
        key
        for key, value in _TRACKING_CACHE.items()
        if now - float(value.get("updatedAt", 0.0))
        > _TRACKING_TTL_SECONDS
    ]
    for key in expired:
        _TRACKING_CACHE.pop(key, None)
    while len(_TRACKING_CACHE) > _TRACKING_CACHE_LIMIT:
        _TRACKING_CACHE.popitem(last=False)


def _try_tracked_registration(
    gray: np.ndarray,
    options: Dict[str, Any],
) -> Optional[Tuple[np.ndarray, Dict[str, Any]]]:
    """Update the last accepted transform with LK flow and RANSAC."""

    key = _tracking_key(options)
    if key is None or bool(options.get("resetTracking")):
        if key is not None:
            _TRACKING_CACHE.pop(key, None)
        return None
    now = time.monotonic()
    _prune_tracking_cache(now)
    entry = _TRACKING_CACHE.get(key)
    if entry is None:
        return None
    frame_id = _tracking_frame_id(options)
    previous_frame_id = entry.get("frameId")
    if (
        frame_id is not None
        and isinstance(previous_frame_id, int)
        and frame_id <= previous_frame_id
    ):
        # A delayed response must never move a live session's homography
        # backwards. The caller will fall through to a fresh registration.
        return None
    current, current_scale = _tracking_small(gray)
    if current.shape != entry["small"].shape:
        _TRACKING_CACHE.pop(key, None)
        return None
    # Track against a fixed verified frame, not a chain of noisy homographies.
    # Otherwise subpixel errors accumulate and shift bubble sampling over time.
    anchor_small = entry.get("anchorSmall", entry["small"])
    previous_points = np.asarray(entry.get("anchorPoints", entry.get("points")), dtype=np.float32)
    if previous_points.ndim != 3 or len(previous_points) < 24:
        _TRACKING_CACHE.pop(key, None)
        return None
    current_points, status, flow_error = cv2.calcOpticalFlowPyrLK(
        anchor_small,
        current,
        previous_points,
        None,
        winSize=(25, 25),
        maxLevel=3,
        criteria=(
            cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT,
            30,
            0.01,
        ),
    )
    if current_points is None or status is None:
        return None
    valid = status.reshape(-1).astype(bool)
    if flow_error is not None:
        valid &= flow_error.reshape(-1) < 24.0
    # A one-way flow can follow a similar neighboring printed row. Require
    # each match to return to the same point when tracked backwards.
    back_points, back_status, _ = cv2.calcOpticalFlowPyrLK(
        current, anchor_small, current_points, None, winSize=(25, 25), maxLevel=3,
        criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, 0.01),
    )
    if back_points is None or back_status is None:
        return None
    valid &= back_status.reshape(-1).astype(bool)
    valid &= np.linalg.norm(back_points - previous_points, axis=2).reshape(-1) <= 0.8
    previous_valid = previous_points.reshape(-1, 2)[valid]
    current_valid = current_points.reshape(-1, 2)[valid]
    if len(previous_valid) < 20:
        return None
    cv2.setRNGSeed(2939)
    delta, inlier_mask = cv2.findHomography(
        previous_valid,
        current_valid,
        cv2.USAC_MAGSAC,
        2.5,
    )
    if delta is None or inlier_mask is None:
        return None
    inliers = inlier_mask.reshape(-1).astype(bool)
    inlier_count = int(inliers.sum())
    inlier_ratio = inlier_count / max(1, len(previous_valid))
    if inlier_count < 18 or inlier_ratio < 0.52:
        return None
    projected = cv2.perspectiveTransform(
        previous_valid[inliers].reshape(-1, 1, 2), delta
    ).reshape(-1, 2)
    median_error = float(
        np.median(
            np.linalg.norm(projected - current_valid[inliers], axis=1)
        )
    )
    tracked_span = previous_valid[inliers]
    span_x = float(np.ptp(tracked_span[:, 0]))
    span_y = float(np.ptp(tracked_span[:, 1]))
    if (
        median_error > 2.5
        or span_x < current.shape[1] * 0.16
        or span_y < current.shape[0] * 0.34
    ):
        return None
    scale_matrix = np.asarray(
        [
            [current_scale, 0.0, 0.0],
            [0.0, current_scale, 0.0],
            [0.0, 0.0, 1.0],
        ],
        dtype=np.float64,
    )
    delta_full = (
        np.linalg.inv(scale_matrix)
        @ delta
        @ np.diag([float(entry.get("anchorScale", entry["smallScale"])),
                   float(entry.get("anchorScale", entry["smallScale"])), 1.0])
    )
    source_to_canonical = (
        np.asarray(entry.get("anchorToCanonical", entry["sourceToCanonical"]), dtype=np.float64)
        @ np.linalg.inv(delta_full)
    )
    warped = cv2.warpPerspective(
        gray,
        source_to_canonical,
        (CANONICAL_WIDTH, CANONICAL_HEIGHT),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=255,
    )
    verified_grid = entry.get("verifiedGrid")
    if verified_grid is not None:
        # A changed answer field must get an independent registration. Reusing
        # an old sampling transform can make a faint added/erased mark appear
        # confident even though the normal fresh-image detector would abstain.
        current_ink = _ink_signature(warped, verified_grid[0])
        previous_ink = verified_grid[3]
        low = previous_ink <= np.percentile(previous_ink, 40)
        high = previous_ink >= np.percentile(previous_ink, 80)
        old_low, old_high = np.median(previous_ink[low]), np.median(previous_ink[high])
        new_low, new_high = np.median(current_ink[low]), np.median(current_ink[high])
        # Mild focus/exposure changes affect the entire ink population. Remove
        # only a bounded global contrast change, retaining local added/erased
        # marks and large content changes as independent-registration triggers.
        gain = np.clip((new_high-new_low) / max(25, old_high-old_low), .85, 1.15)
        offset = np.clip(new_low-gain*old_low, -5, 5)
        if np.max(np.abs(current_ink - (gain*previous_ink+offset))) > 20.0:
            options["_requireFreshRegistration"] = True
            return None
    tracking_confidence = 100.0 * (
        0.44 * min(1.0, inlier_count / 80.0)
        + 0.28 * min(1.0, inlier_ratio / 0.80)
        + 0.16 * max(0.0, 1.0 - median_error / 2.5)
        + 0.12
    )
    return warped, {
        "detected": True,
        "acceptable": tracking_confidence >= 52.0,
        "confidence": round(tracking_confidence, 2),
        "registrationConfidence": round(tracking_confidence, 2),
        "trackingConfidence": round(tracking_confidence, 2),
        "trackedPoints": len(previous_valid),
        "trackingInliers": inlier_count,
        "trackingInlierRatio": round(inlier_ratio, 4),
        "trackingReprojectionError": round(median_error, 4),
        "_verifiedGrid": entry.get("verifiedGrid"),
        "locator": "temporal-lk-usac",
        "outlineRequired": False,
        "templateId": entry.get("templateId"),
        "templateRowStart": entry.get("templateRowStart"),
        "templateRowSpacing": entry.get("templateRowSpacing"),
        "canonicalSize": [CANONICAL_WIDTH, CANONICAL_HEIGHT],
        "perspectiveTransform": [
            [round(float(value), 8) for value in row]
            for row in source_to_canonical
        ],
    }


def _reference_frame_registration_candidates(
    gray: np.ndarray,
    options: Dict[str, Any],
) -> List[Tuple[np.ndarray, Dict[str, Any]]]:
    """Align immutable print to the last fully verified camera frame.

    Repetitive question rows can make a direct canonical-template SIFT match
    jump to the wrong block or row.  A previously accepted frame has the same
    camera sampling, blur, and paper scale, so its masked immutable print is a
    much stronger registration reference.  This function only proposes a
    homography; the caller still requires projected visibility, both answer
    blocks, absolute row phase, and the complete current 50x4 ring lattice.
    """

    key = _tracking_key(options)
    if key is None or not hasattr(cv2, "SIFT_create"):
        return []
    now = time.monotonic()
    _prune_tracking_cache(now)
    entry = _TRACKING_CACHE.get(key)
    if entry is None:
        return []
    reference_points = np.asarray(
        entry.get("referenceKeypoints"), dtype=np.float32
    )
    reference_descriptors = entry.get("referenceDescriptors")
    if (
        reference_points.ndim != 2
        or reference_points.shape[1:] != (2,)
        or len(reference_points) < 24
        or not isinstance(reference_descriptors, np.ndarray)
        or len(reference_descriptors) != len(reference_points)
    ):
        return []

    current, current_scale = _tracking_small(gray)
    reference_scale = float(entry.get("referenceScale", entry.get("smallScale", 0.0)))
    reference_shape = entry.get("referenceShape", entry["small"].shape)
    if (
        current.shape != tuple(reference_shape)
        or reference_scale <= 0
    ):
        return []
    detector = cv2.SIFT_create(
        nfeatures=5000,
        contrastThreshold=0.008,
        edgeThreshold=16,
    )
    target_keypoints, target_descriptors = detector.detectAndCompute(
        current, None
    )
    if target_descriptors is None or len(target_keypoints) < 40:
        return []
    target_points_all = np.asarray(
        [keypoint.pt for keypoint in target_keypoints], dtype=np.float32
    )
    matches_by_ratio = cv2.BFMatcher(cv2.NORM_L2).knnMatch(
        reference_descriptors, target_descriptors, k=2
    )
    reference_to_canonical = np.asarray(
        entry.get("referenceSourceToCanonical", entry.get("sourceToCanonical")), dtype=np.float64
    )
    if reference_to_canonical.shape != (3, 3):
        return []
    template = next(
        (item for item in _load_registration_templates() if item.get("primary")),
        None,
    )
    if template is None:
        return []

    scale_matrix = np.asarray(
        [
            [current_scale, 0.0, 0.0],
            [0.0, current_scale, 0.0],
            [0.0, 0.0, 1.0],
        ],
        dtype=np.float64,
    )
    candidates: List[Tuple[np.ndarray, Dict[str, Any]]] = []
    for ratio in (0.72, 0.78, 0.84, 0.88):
        matches = [
            first
            for first, second in matches_by_ratio
            if first.distance < ratio * second.distance
        ]
        if len(matches) < 12:
            continue
        matched_reference = np.asarray(
            [reference_points[match.queryIdx] for match in matches],
            dtype=np.float32,
        )
        matched_target = np.asarray(
            [target_points_all[match.trainIdx] for match in matches],
            dtype=np.float32,
        )
        cv2.setRNGSeed(2939)
        delta, inlier_mask = cv2.findHomography(
            matched_reference,
            matched_target,
            cv2.USAC_MAGSAC,
            2.5,
        )
        if delta is None or inlier_mask is None:
            continue
        inliers = inlier_mask.reshape(-1).astype(bool)
        inlier_count = int(inliers.sum())
        inlier_ratio = inlier_count / max(1, len(matches))
        if inlier_count < 12 or inlier_ratio < 0.18:
            continue
        projected = cv2.perspectiveTransform(
            matched_reference[inliers].reshape(-1, 1, 2), delta
        ).reshape(-1, 2)
        median_error = float(np.median(np.linalg.norm(
            projected - matched_target[inliers], axis=1
        )))
        if not math.isfinite(median_error) or median_error > 2.0:
            continue
        canonical_inliers = cv2.perspectiveTransform(
            (
                matched_reference[inliers] / max(1e-6, reference_scale)
            ).reshape(-1, 1, 2),
            reference_to_canonical,
        ).reshape(-1, 2)
        y_span = float(np.ptp(canonical_inliers[:, 1]))
        left_support = int(np.sum(canonical_inliers[:, 0] < CANONICAL_WIDTH * 0.49))
        right_support = int(np.sum(canonical_inliers[:, 0] >= CANONICAL_WIDTH * 0.49))
        if y_span < 620.0 or min(left_support, right_support) < 3:
            continue
        try:
            delta_full = np.linalg.inv(scale_matrix) @ delta @ np.diag([reference_scale, reference_scale, 1.0])
            source_to_canonical = (
                reference_to_canonical @ np.linalg.inv(delta_full)
            )
            canonical_to_source = np.linalg.inv(source_to_canonical)
        except (cv2.error, np.linalg.LinAlgError):
            continue
        projected_bubbles = cv2.perspectiveTransform(
            template["centers"].reshape(-1, 1, 2),
            canonical_to_source,
        ).reshape(-1, 2)
        height, width = gray.shape
        inside = (
            (projected_bubbles[:, 0] >= 4)
            & (projected_bubbles[:, 0] < width - 4)
            & (projected_bubbles[:, 1] >= 4)
            & (projected_bubbles[:, 1] < height - 4)
        )
        visible_fraction = float(np.mean(inside))
        if visible_fraction < 0.96:
            continue
        registration_confidence = 100.0 * (
            0.30 * min(1.0, inlier_count / 40.0)
            + 0.20 * min(1.0, inlier_ratio / 0.50)
            + 0.20 * min(1.0, y_span / 1300.0)
            + 0.15 * min(1.0, min(left_support, right_support) / 5.0)
            + 0.15 * max(0.0, 1.0 - median_error / 2.0)
        )
        if registration_confidence < REFERENCE_FRAME_MIN_REGISTRATION_CONFIDENCE:
            continue
        visible_rows = inside.reshape(50, 4).all(axis=1)
        questions_outside = [
            int(index + 1)
            for index, visible in enumerate(visible_rows)
            if not bool(visible)
        ]
        warped = cv2.warpPerspective(
            gray,
            source_to_canonical,
            (CANONICAL_WIDTH, CANONICAL_HEIGHT),
            flags=cv2.INTER_LINEAR,
            borderMode=cv2.BORDER_CONSTANT,
            borderValue=255,
        )
        candidates.append((warped, {
            "detected": True,
            "acceptable": True,
            "confidence": round(registration_confidence, 2),
            "registrationConfidence": round(registration_confidence, 2),
            "referenceMatches": len(matches),
            "referenceInliers": inlier_count,
            "referenceInlierRatio": round(inlier_ratio, 4),
            "referenceReprojectionError": round(median_error, 4),
            "featureMatches": len(matches),
            "inliers": inlier_count,
            "medianReprojectionError": round(median_error, 4),
            "templateYSpan": round(y_span, 3),
            "leftStaticSupport": left_support,
            "rightStaticSupport": right_support,
            "projectedBubbleVisibility": round(visible_fraction, 4),
            "questionsOutsideFrame": questions_outside,
            "referenceAgeSeconds": round(
                max(0.0, now - float(entry.get("updatedAt", now))), 3
            ),
            "locator": "reference-frame-sift-usac",
            "outlineRequired": False,
            "templateId": entry.get("templateId"),
            "templateRowStart": entry.get("templateRowStart"),
            "templateRowSpacing": entry.get("templateRowSpacing"),
            "canonicalSize": [CANONICAL_WIDTH, CANONICAL_HEIGHT],
            "perspectiveTransform": [
                [round(float(value), 8) for value in row]
                for row in source_to_canonical
            ],
        }))
    candidates.sort(
        key=lambda candidate: (
            candidate[1]["registrationConfidence"],
            candidate[1]["referenceInliers"],
            -candidate[1]["referenceReprojectionError"],
        ),
        reverse=True,
    )
    return candidates[:3]


def _update_tracking_cache(
    gray: np.ndarray,
    options: Dict[str, Any],
    placement: Dict[str, Any],
) -> None:
    key = _tracking_key(options)
    transform_values = placement.get("perspectiveTransform")
    if key is None or transform_values is None:
        return
    frame_id = _tracking_frame_id(options)
    previous = _TRACKING_CACHE.get(key)
    previous_frame_id = previous.get("frameId") if previous else None
    if (
        frame_id is not None
        and isinstance(previous_frame_id, int)
        and frame_id <= previous_frame_id
    ):
        return
    try:
        source_to_canonical = np.asarray(
            transform_values, dtype=np.float64
        ).reshape(3, 3)
        canonical_to_source = np.linalg.inv(source_to_canonical)
    except (ValueError, TypeError, np.linalg.LinAlgError):
        return
    small, scale = _tracking_small(gray)
    canonical_to_small = np.asarray(
        [
            [scale, 0.0, 0.0],
            [0.0, scale, 0.0],
            [0.0, 0.0, 1.0],
        ],
        dtype=np.float64,
    ) @ canonical_to_source
    # Track only immutable title/question-number/footer print. Filled answers,
    # names, QR data, and other per-student content must not influence the
    # temporal registration state.
    mask = cv2.warpPerspective(
        _registration_static_mask(
            (CANONICAL_HEIGHT, CANONICAL_WIDTH)
        ),
        canonical_to_small,
        (small.shape[1], small.shape[0]),
        flags=cv2.INTER_NEAREST,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=0,
    )
    retain_anchor = previous is not None and placement.get("locator") == "temporal-lk-usac"
    points = previous.get("anchorPoints", previous.get("points")) if retain_anchor else cv2.goodFeaturesToTrack(
        small,
        maxCorners=320,
        qualityLevel=0.012,
        minDistance=7,
        mask=mask,
        blockSize=5,
        useHarrisDetector=False,
    )
    if points is None or len(points) < 24:
        return
    reference_keypoints = None
    reference_descriptors = None
    reference_transform = source_to_canonical
    reference_scale = scale
    reference_shape = small.shape
    reference_updated_at = time.monotonic()
    reuse_reference = (
        previous is not None
        and placement.get("locator") == "temporal-lk-usac"
        and isinstance(previous.get("referenceDescriptors"), np.ndarray)
    )
    if reuse_reference:
        # Descriptors belong to their original frame. Retain that frame's
        # transform and scale too; using the latest transform corrupts recovery.
        reference_keypoints = previous["referenceKeypoints"]
        reference_descriptors = previous["referenceDescriptors"]
        reference_transform = previous["referenceSourceToCanonical"]
        reference_scale = previous["referenceScale"]
        reference_shape = previous["referenceShape"]
        reference_updated_at = previous["referenceUpdatedAt"]
    elif hasattr(cv2, "SIFT_create"):
        reference_detector = cv2.SIFT_create(
            nfeatures=1800,
            contrastThreshold=0.008,
            edgeThreshold=16,
        )
        detected_keypoints, detected_descriptors = (
            reference_detector.detectAndCompute(small, mask)
        )
        if (
            detected_descriptors is not None
            and len(detected_keypoints) >= 24
        ):
            reference_keypoints = np.asarray(
                [keypoint.pt for keypoint in detected_keypoints],
                dtype=np.float32,
            )
            reference_descriptors = detected_descriptors.copy()
    _TRACKING_CACHE[key] = {
        "updatedAt": time.monotonic(),
        "frameId": frame_id,
        "sourceShape": tuple(gray.shape),
        "small": small.copy(),
        "smallScale": scale,
        "points": points,
        "anchorSmall": previous.get("anchorSmall", previous["small"]) if retain_anchor else small.copy(),
        "anchorPoints": points,
        "anchorScale": previous.get("anchorScale", previous["smallScale"]) if retain_anchor else scale,
        "anchorToCanonical": previous.get("anchorToCanonical", previous["sourceToCanonical"]) if retain_anchor else source_to_canonical,
        "referenceKeypoints": reference_keypoints,
        "referenceDescriptors": reference_descriptors,
        "referenceSourceToCanonical": reference_transform,
        "referenceScale": reference_scale,
        "referenceShape": reference_shape,
        "referenceUpdatedAt": reference_updated_at,
        "sourceToCanonical": source_to_canonical,
        "templateId": placement.get("templateId"),
        "templateRowStart": placement.get(
            "templateRowStart",
            NOMINAL_TOP_Y * CANONICAL_HEIGHT,
        ),
        "templateRowSpacing": placement.get(
            "templateRowSpacing",
            NOMINAL_ROW_SPACING * CANONICAL_HEIGHT,
        ),
    }
    _TRACKING_CACHE.move_to_end(key)
    _prune_tracking_cache()


def _deduplicate_circles(circles: Iterable[Sequence[float]], distance: float = 4.0) -> np.ndarray:
    ordered = sorted(circles, key=lambda item: float(item[2]), reverse=True)
    kept: List[Tuple[float, float, float]] = []
    distance_squared = distance * distance
    cell_size = max(1.0, distance)
    spatial: Dict[Tuple[int, int], List[int]] = {}
    for x, y, radius in ordered:
        cell_x = math.floor(float(x) / cell_size)
        cell_y = math.floor(float(y) / cell_size)
        duplicate = False
        for neighbor_y in range(cell_y - 1, cell_y + 2):
            for neighbor_x in range(cell_x - 1, cell_x + 2):
                for kept_index in spatial.get(
                    (neighbor_x, neighbor_y), ()
                ):
                    kept_x, kept_y, _ = kept[kept_index]
                    if (
                        (float(x) - kept_x) ** 2
                        + (float(y) - kept_y) ** 2
                        <= distance_squared
                    ):
                        duplicate = True
                        break
                if duplicate:
                    break
            if duplicate:
                break
        if duplicate:
            continue
        kept_index = len(kept)
        kept.append((float(x), float(y), float(radius)))
        spatial.setdefault((cell_x, cell_y), []).append(kept_index)
    if not kept:
        return np.empty((0, 3), dtype=np.float32)
    return np.asarray(kept, dtype=np.float32)


def _contour_circle_candidates(
    binary_roi: np.ndarray,
    offset_x: int,
    offset_y: int,
    minimum_radius: float,
    maximum_radius: float,
) -> List[Tuple[float, float, float]]:
    contours, _ = cv2.findContours(binary_roi, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    candidates: List[Tuple[float, float, float]] = []
    minimum_extent = max(8, round(minimum_radius * 1.65))
    maximum_extent = round(maximum_radius * 2.15)
    minimum_area = math.pi * minimum_radius * minimum_radius * 0.46
    maximum_area = math.pi * maximum_radius * maximum_radius * 1.30
    for contour in contours:
        area = float(cv2.contourArea(contour))
        if area < minimum_area or area > maximum_area:
            continue
        x, y, width, height = cv2.boundingRect(contour)
        if (
            width < minimum_extent
            or height < minimum_extent
            or width > maximum_extent
            or height > maximum_extent
        ):
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


def _find_bubble_candidates(
    warped: np.ndarray,
    tolerances: Optional[Dict[str, float]] = None,
) -> Tuple[np.ndarray, np.ndarray, Dict[str, Any]]:
    started = time.perf_counter()
    tolerances = tolerances or DEFAULT_GEOMETRY_TOLERANCES
    left, top, right, bottom = ANSWER_ROI
    roi = warped[top:bottom, left:right]
    p10, p90 = _uint8_percentiles(roi, [10, 90])
    local_range = float(p90 - p10)
    clahe_used = local_range < 82.0
    locator_roi = roi
    if clahe_used:
        locator_roi = cv2.createCLAHE(clipLimit=1.6, tileGridSize=(8, 8)).apply(roi)

    minimum_radius = max(
        5, round(CANONICAL_WIDTH * tolerances["bubbleRadiusMinRatio"])
    )
    maximum_radius = max(
        minimum_radius + 3,
        round(CANONICAL_WIDTH * tolerances["bubbleRadiusMaxRatio"]),
    )
    hough_scale = _BUBBLE_HOUGH_SCALE
    hough_roi = cv2.resize(
        locator_roi,
        None,
        fx=hough_scale,
        fy=hough_scale,
        interpolation=cv2.INTER_AREA,
    )
    smooth = cv2.GaussianBlur(hough_roi, (3, 3), 0)
    hough = cv2.HoughCircles(
        smooth,
        cv2.HOUGH_GRADIENT,
        dp=1.1,
        minDist=max(
            5,
            round(CANONICAL_WIDTH * 0.015 * hough_scale),
        ),
        param1=90,
        param2=max(10, round(16 * hough_scale)),
        minRadius=max(4, round(minimum_radius * hough_scale)),
        maxRadius=max(6, round(maximum_radius * hough_scale)),
    )
    candidates: List[Tuple[float, float, float]] = []
    hough_count = 0
    if hough is not None:
        for x, y, radius in hough[0]:
            candidates.append((
                left + float(x) / hough_scale,
                top + float(y) / hough_scale,
                float(radius) / hough_scale,
            ))
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
    radius_floor = max(
        minimum_radius * 0.92,
        min(maximum_radius * 0.62, radius_reference * 0.76),
    )
    bubble_sized = circles[circles[:, 2] >= radius_floor] if len(circles) else circles

    # Contours supplement (not replace) Hough evidence only when the Hough
    # population is incomplete.  Avoiding a second full candidate merge on a
    # clean sheet saves substantial live-frame latency.
    contour_candidates: List[Tuple[float, float, float]] = []
    if len(bubble_sized) < 110:
        contour_candidates = _contour_circle_candidates(
            adaptive, left, top, minimum_radius, maximum_radius
        )
        candidates.extend(contour_candidates)
        circles = _deduplicate_circles(candidates)
    if len(circles) < 8:
        raise OmrRejected(
            "Too few printed bubble rings are visible",
            {
                "stage": "bubble-candidate-detection",
                "houghCandidates": hough_count,
                "contourCandidates": len(contour_candidates),
                "bubbleCandidates": int(len(circles)),
                "geometryConfidence": 0.0,
                "requiredGeometryConfidence": tolerances[
                    "minimumGeometryConfidence"
                ],
            },
        )

    # Question numbers form smaller pseudo-circles.  Retaining the upper radius
    # population is what prevents the historic “number + A/B/C = A/B/C/D”
    # one-column shift.
    radius_reference = float(np.percentile(circles[:, 2], 65))
    radius_floor = max(
        minimum_radius * 0.92,
        min(maximum_radius * 0.62, radius_reference * 0.76),
    )
    bubble_sized = circles[circles[:, 2] >= radius_floor]
    if len(bubble_sized) < 8:
        raise OmrRejected(
            "Printed bubble geometry is not sharp enough",
            {
                "stage": "bubble-candidate-detection",
                "bubbleCandidates": int(len(circles)),
                "bubbleSizedCandidates": int(len(bubble_sized)),
                "radiusFloor": round(radius_floor, 3),
                "geometryConfidence": 0.0,
                "requiredGeometryConfidence": tolerances[
                    "minimumGeometryConfidence"
                ],
            },
        )
    return bubble_sized, adaptive, {
        "houghCandidates": hough_count,
        "contourCandidates": len(contour_candidates),
        "bubbleCandidates": int(len(circles)),
        "bubbleSizedCandidates": int(len(bubble_sized)),
        "radiusFloor": round(radius_floor, 3),
        "medianRadius": round(float(np.median(bubble_sized[:, 2])), 3),
        "radiusRange": [minimum_radius, maximum_radius],
        "houghScale": hough_scale,
        "claheUsed": clahe_used,
        "roiIntensityRange": round(local_range, 3),
        "processingMs": _stage_ms(started),
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

    row_indices = np.arange(count, dtype=np.float32)

    def evaluate(starts: np.ndarray, spacings: np.ndarray) -> Tuple[int, int]:
        positions = (
            starts[:, None, None]
            + spacings[None, :, None] * row_indices[None, None, :]
        )
        scores = np.interp(
            positions.reshape(-1), _profile_coordinates(length), profile
        ).reshape(len(starts), len(spacings), count).sum(axis=2)
        return np.unravel_index(np.argmax(scores), scores.shape)

    # Coarse-to-fine search avoids allocating a large start x spacing x row
    # cube when tolerances are broad. It preserves sub-pixel registration
    # while keeping the flexible path suitable for live scanning.
    coarse_start_step = max(1.0, (start_high - start_low) / 220.0)
    coarse_spacing_step = max(0.25, (spacing_high - spacing_low) / 110.0)
    coarse_starts = np.arange(
        start_low, start_high, coarse_start_step, dtype=np.float32
    )
    coarse_spacings = np.arange(
        spacing_low, spacing_high, coarse_spacing_step, dtype=np.float32
    )
    coarse_i, coarse_j = evaluate(coarse_starts, coarse_spacings)
    coarse_start = float(coarse_starts[coarse_i])
    coarse_spacing = float(coarse_spacings[coarse_j])

    starts = np.arange(
        max(start_low, coarse_start - coarse_start_step * 1.5),
        min(start_high, coarse_start + coarse_start_step * 1.5) + 0.001,
        0.25,
        dtype=np.float32,
    )
    spacings = np.arange(
        max(spacing_low, coarse_spacing - coarse_spacing_step * 1.5),
        min(spacing_high, coarse_spacing + coarse_spacing_step * 1.5) + 0.001,
        0.05,
        dtype=np.float32,
    )
    best_start, best_spacing = evaluate(starts, spacings)
    best_positions = (
        starts[best_start]
        + spacings[best_spacing] * row_indices
    )
    best_score = float(np.interp(
        best_positions, _profile_coordinates(length), profile
    ).sum())
    return (
        best_score,
        float(starts[best_start]),
        float(spacings[best_spacing]),
    )


def _deskew_answer_lanes(circles: np.ndarray) -> Tuple[np.ndarray, List[float]]:
    """Remove residual lane tilt using nearby rings from the same column.

    A full-height x histogram smears four slanted lanes into a narrower,
    incorrect lattice. Short vertical ring pairs measure tilt independently
    of A-D spacing. All visibility and absolute row checks still run below.
    """
    corrected = circles.copy()
    slopes = []
    for left, right in ((0.02, 0.49), (0.49, 0.98)):
        mask = (circles[:, 0] >= CANONICAL_WIDTH * left) & (
            circles[:, 0] <= CANONICAL_WIDTH * right)
        points = circles[mask]
        # Bound pairwise work on cluttered frames; reject/recover through the
        # ordinary geometry checks when there is no reliable tilt estimate.
        slope = 0.0
        if 24 <= len(points) <= 600:
            dx = points[:, None, 0] - points[None, :, 0]
            dy = points[:, None, 1] - points[None, :, 1]
            pairs = (dy >= 40.0) & (dy <= 200.0) & (np.abs(dx) <= dy * 0.035)
            estimates = dx[pairs] / dy[pairs]
            if len(estimates) >= 24:
                median = float(np.median(estimates))
                deviation = float(np.median(np.abs(estimates - median)))
                if deviation <= 0.008:
                    slope = median
        corrected[mask, 0] -= slope * (points[:, 1] - CANONICAL_HEIGHT * 0.5)
        slopes.append(slope)
    return corrected, slopes


def _refine_block_lattice(
    points: np.ndarray,
    y_fit: Tuple[float, float, float],
    x_fit: Tuple[float, float, float],
    tolerances: Optional[Dict[str, float]] = None,
) -> Dict[str, Any]:
    tolerances = tolerances or DEFAULT_GEOMETRY_TOLERANCES
    y0, row_spacing = y_fit[1], y_fit[2]
    x0, choice_spacing = x_fit[1], x_fit[2]
    x_coeff = np.asarray([x0, choice_spacing, 0.0], dtype=np.float64)
    y_coeff = np.asarray([y0, row_spacing, 0.0], dtype=np.float64)
    max_dx = max(
        CANONICAL_WIDTH * 0.008,
        choice_spacing * tolerances["assignmentXFraction"],
    )
    max_dy = max(
        CANONICAL_HEIGHT * 0.0028,
        row_spacing * tolerances["assignmentYFraction"],
    )

    selected_cells: Dict[Tuple[int, int], np.ndarray] = {}
    for _ in range(3):
        selected_cells = {}
        # Invert the fitted affine grid, rather than assigning every point
        # against the middle row. This keeps bottom rows in the correct lane
        # under residual shear and avoids repeated per-ring allocations.
        basis = np.asarray([[x_coeff[1], x_coeff[2]], [y_coeff[2], y_coeff[1]]])
        coordinates = (points[:, :2] - [x_coeff[0], y_coeff[0]]) @ np.linalg.inv(basis).T
        lanes = np.clip(np.rint(coordinates[:, 0]).astype(np.int32), 0, 3)
        rows = np.clip(np.rint(coordinates[:, 1]).astype(np.int32), 0, 24)
        dx = np.abs(points[:, 0] - (x_coeff[0] + x_coeff[1] * lanes + x_coeff[2] * rows))
        dy = np.abs(points[:, 1] - (y_coeff[0] + y_coeff[1] * rows + y_coeff[2] * lanes))
        distances = (dx / max_dx) ** 2 + (dy / max_dy) ** 2
        accepted = np.flatnonzero((dx <= max_dx) & (dy <= max_dy))
        for index in accepted[np.argsort(distances[accepted], kind="stable")]:
            key = (int(rows[index]), int(lanes[index]))
            if key not in selected_cells:
                selected_cells[key] = np.asarray([*points[index, :3], distances[index]], dtype=np.float64)

        if len(selected_cells) < 24:
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
            choice_spacing * 0.68 <= candidate_x[1] <= choice_spacing * 1.32
            and abs(candidate_x[2]) <= max(1.5, choice_spacing * 0.06)
            and row_spacing * 0.72 <= candidate_y[1] <= row_spacing * 1.28
            and abs(candidate_y[2]) <= max(2.0, row_spacing * 0.08)
        ):
            x_coeff = candidate_x
            y_coeff = candidate_y
            max_dx = max(
                CANONICAL_WIDTH * 0.008,
                abs(float(x_coeff[1]))
                * tolerances["assignmentXFraction"],
            )
            max_dy = max(
                CANONICAL_HEIGHT * 0.0028,
                abs(float(y_coeff[1]))
                * tolerances["assignmentYFraction"],
            )

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
    modeled_centers = centers.copy()
    # Refine each predicted cell locally instead of requiring every printed
    # ring to obey one perfect affine lattice.  Supported cells use their
    # observed ring center; missing/filled cells inherit a robust row-local
    # displacement from neighboring rings.  This absorbs minor print stretch,
    # page bending, and residual lens/perspective error without changing row
    # or A-D identity.
    row_offsets = np.full((25, 2), np.nan, dtype=np.float32)
    for row in range(25):
        offsets = [
            selected_cells[(row, lane)][:2] - modeled_centers[row, lane]
            for lane in range(4)
            if (row, lane) in selected_cells
        ]
        if len(offsets) >= 2:
            row_offsets[row] = np.median(
                np.asarray(offsets, dtype=np.float32), axis=0
            )
    supported_rows = np.flatnonzero(np.isfinite(row_offsets[:, 0]))
    if len(supported_rows) >= 2:
        for coordinate in range(2):
            row_offsets[:, coordinate] = np.interp(
                np.arange(25, dtype=np.float32),
                supported_rows.astype(np.float32),
                row_offsets[supported_rows, coordinate],
            )
        row_offsets[:, 0] = np.clip(
            row_offsets[:, 0], -max_dx * 0.45, max_dx * 0.45
        )
        row_offsets[:, 1] = np.clip(
            row_offsets[:, 1], -max_dy * 0.45, max_dy * 0.45
        )
        centers += row_offsets[:, None, :] * 0.38
    localization_confidence = np.zeros((25, 4), dtype=np.float32)
    for row in range(25):
        for lane in range(4):
            observed = selected_cells.get((row, lane))
            if observed is not None:
                modeled = modeled_centers[row, lane]
                locally_adjusted = centers[row, lane]
                observed_xy = observed[:2].astype(np.float32)
                centers[row, lane] = (
                    0.38 * observed_xy + 0.62 * locally_adjusted
                )
                normalized_distance = math.hypot(
                    (float(observed_xy[0]) - float(modeled[0])) / max_dx,
                    (float(observed_xy[1]) - float(modeled[1])) / max_dy,
                )
                localization_confidence[row, lane] = max(
                    45.0, 100.0 - 45.0 * normalized_distance
                )
            elif np.isfinite(row_offsets[row, 0]):
                localization_confidence[row, lane] = 58.0
            else:
                localization_confidence[row, lane] = 34.0
    residuals = []
    for (row, lane), observed in selected_cells.items():
        predicted_x = x_coeff[0] + x_coeff[1] * lane + x_coeff[2] * row
        predicted_y = y_coeff[0] + y_coeff[1] * row + y_coeff[2] * lane
        residuals.append(
            math.hypot(
                (float(observed[0]) - predicted_x) / max_dx,
                (float(observed[1]) - predicted_y) / max_dy,
            )
        )
    return {
        "centers": centers,
        "support": support,
        "xCoefficients": [round(float(value), 5) for value in x_coeff],
        "yCoefficients": [round(float(value), 5) for value in y_coeff],
        "cellSupport": int(support.sum()),
        "rowSupport": int(np.sum(support.sum(axis=1) >= 2)),
        "rowCellSupport": [
            int(value) for value in support.sum(axis=1)
        ],
        "laneSupport": [int(value) for value in support.sum(axis=0)],
        "assignmentTolerance": {
            "x": round(float(max_dx), 3),
            "y": round(float(max_dy), 3),
        },
        "normalizedResidual": round(float(np.median(residuals)), 4) if residuals else 1.0,
        "bubbleLocalizationConfidence": round(
            float(np.mean(localization_confidence)), 2
        ),
        "localizationConfidence": [
            [round(float(value), 2) for value in row]
            for row in localization_confidence
        ],
    }


def _measure_lattice_support(
    points: np.ndarray,
    x_fit: Tuple[float, float, float],
    y_fit: Tuple[float, float, float],
    tolerances: Dict[str, float],
) -> Dict[str, Any]:
    """Measure unique 25x4 ring support for one answer block.

    The shared row profile is normally the strongest constraint.  A camera
    homography cannot, however, remove page curl: on a bent sheet one block's
    first rows can be displaced by more than the normal assignment window
    even though both physical edges are visible.  This helper is used only to
    compare bounded row-phase hypotheses before the normal strict refinement.
    """

    support = np.zeros((25, 4), dtype=np.uint8)
    if points.size == 0:
        return {
            "support": support,
            "cellSupport": 0,
            "rowSupport": 0,
            "edgeRows": 0,
            "edgeCellSupport": 0,
        }

    expected_x = x_fit[1] + np.arange(4, dtype=np.float32) * x_fit[2]
    expected_y = y_fit[1] + np.arange(25, dtype=np.float32) * y_fit[2]
    x_distances = np.abs(points[:, 0, None] - expected_x[None, :])
    y_distances = np.abs(points[:, 1, None] - expected_y[None, :])
    lanes = np.argmin(x_distances, axis=1)
    rows = np.argmin(y_distances, axis=1)
    point_indices = np.arange(len(points))
    max_dx = max(
        CANONICAL_WIDTH * 0.008,
        x_fit[2] * tolerances["assignmentXFraction"],
    )
    max_dy = max(
        CANONICAL_HEIGHT * 0.0032,
        y_fit[2] * tolerances["assignmentYFraction"],
    )
    accepted = (
        x_distances[point_indices, lanes] <= max_dx
    ) & (
        y_distances[point_indices, rows] <= max_dy
    )
    support[rows[accepted], lanes[accepted]] = 1
    row_cells = support.sum(axis=1)
    edge_cells = int(row_cells[0] + row_cells[-1])
    return {
        "support": support,
        "cellSupport": int(support.sum()),
        "rowSupport": int(np.sum(row_cells >= 2)),
        "edgeRows": int(row_cells[0] >= 2) + int(row_cells[-1] >= 2),
        "edgeCellSupport": edge_cells,
    }


def _row_profile_anchor_errors(
    candidate_start: float,
    candidate_spacing: float,
    registered_start: float,
    registered_spacing: float,
    row_count: int = 25,
) -> Tuple[float, float, float]:
    """Return start, end, and maximum template error measured in rows."""

    denominator = max(1.0, float(registered_spacing))
    candidate_end = (
        float(candidate_start)
        + max(0, int(row_count) - 1) * float(candidate_spacing)
    )
    registered_end = (
        float(registered_start)
        + max(0, int(row_count) - 1) * float(registered_spacing)
    )
    start_error = abs(float(candidate_start) - float(registered_start)) / denominator
    end_error = abs(candidate_end - registered_end) / denominator
    return start_error, end_error, max(start_error, end_error)


def _fit_answer_grid(
    circles: np.ndarray,
    tolerances: Optional[Dict[str, float]] = None,
    registration: Optional[Dict[str, Any]] = None,
) -> Tuple[np.ndarray, Dict[str, Any]]:
    """Recover the two answer blocks from normalized current-sheet geometry.

    Search ranges are page-relative and missing rings are inferred from a
    robust affine lattice rather than requiring exact template pixels.
    """
    tolerances = tolerances or DEFAULT_GEOMETRY_TOLERANCES
    geometry_threshold = tolerances["minimumGeometryConfidence"]
    circles, lane_slopes = _deskew_answer_lanes(circles)
    blocks = []
    definitions = (
        (
            CANONICAL_WIDTH * 0.02,
            CANONICAL_WIDTH * 0.49,
            CANONICAL_WIDTH * 0.07,
            CANONICAL_WIDTH * 0.34,
        ),
        (
            CANONICAL_WIDTH * 0.49,
            CANONICAL_WIDTH * 0.98,
            CANONICAL_WIDTH * 0.52,
            CANONICAL_WIDTH * 0.80,
        ),
    )
    answer_points = circles[
        ((circles[:, 0] >= definitions[0][0]) & (circles[:, 0] <= definitions[0][1]))
        | ((circles[:, 0] >= definitions[1][0]) & (circles[:, 0] <= definitions[1][1]))
    ]
    if len(answer_points) < 60:
        raise OmrRejected(
            "The printed answer-grid template is not sufficiently visible",
            {
                "ringCandidates": int(len(answer_points)),
                "stage": "template-registration",
                "geometryConfidence": 0.0,
                "requiredGeometryConfidence": geometry_threshold,
            },
        )
    initial_x_fits = []
    lane_aligned_groups = []
    for region_left, region_right, start_left, start_right in definitions:
        points = circles[
            (circles[:, 0] >= region_left) & (circles[:, 0] <= region_right)
        ]
        initial_x = _fit_periodic_profile(
            points[:, 0],
            CANONICAL_WIDTH,
            start_left,
            start_right,
            CANONICAL_WIDTH * tolerances["choiceSpacingMinRatio"],
            CANONICAL_WIDTH * tolerances["choiceSpacingMaxRatio"],
            4,
        )
        expected_x = initial_x[1] + np.arange(4, dtype=np.float32) * initial_x[2]
        x_distance = np.min(
            np.abs(points[:, 0, None] - expected_x[None, :]), axis=1
        )
        initial_x_fits.append(initial_x)
        lane_aligned_groups.append(
            points[x_distance <= max(8.0, initial_x[2] * 0.36)]
        )
    lane_aligned = np.concatenate(lane_aligned_groups, axis=0)
    if len(lane_aligned) < 25:
        raise OmrRejected(
            "Too few aligned bubble lanes remain to estimate all answer rows",
            {
                "stage": "template-registration",
                "alignedRingCandidates": int(len(lane_aligned)),
                "geometryConfidence": 0.0,
                "requiredGeometryConfidence": geometry_threshold,
            },
        )
    raw_shared_y_fit = _fit_periodic_profile(
        lane_aligned[:, 1],
        CANONICAL_HEIGHT,
        CANONICAL_HEIGHT * 0.15,
        CANONICAL_HEIGHT * 0.34,
        CANONICAL_HEIGHT * tolerances["rowSpacingMinRatio"],
        CANONICAL_HEIGHT * tolerances["rowSpacingMaxRatio"],
        25,
    )
    shared_y_fit = raw_shared_y_fit
    raw_shared_y_start = raw_shared_y_fit[1]
    registration = registration or {}
    locator_method = str(registration.get("locator") or "")
    try:
        registered_row_start = float(
            registration.get(
                "templateRowStart",
                NOMINAL_TOP_Y * CANONICAL_HEIGHT,
            )
        )
    except (TypeError, ValueError):
        registered_row_start = NOMINAL_TOP_Y * CANONICAL_HEIGHT
    try:
        registered_row_spacing = float(
            registration.get(
                "templateRowSpacing",
                NOMINAL_ROW_SPACING * CANONICAL_HEIGHT,
            )
        )
    except (TypeError, ValueError):
        registered_row_spacing = (
            NOMINAL_ROW_SPACING * CANONICAL_HEIGHT
        )
    row_anchor_available = (
        locator_method
        in (
            "sift-static-template-usac",
            "qr-grid-sift-usac",
            "qr-anchor-lattice",
            "temporal-lk-usac",
            "reference-frame-sift-usac",
            "otsu-paper-contour",
            "canny-paper-contour",
        )
        and math.isfinite(registered_row_start)
        and 0.10 * CANONICAL_HEIGHT
        <= registered_row_start
        <= 0.42 * CANONICAL_HEIGHT
        and math.isfinite(registered_row_spacing)
        and (
            CANONICAL_HEIGHT
            * tolerances["rowSpacingMinRatio"]
            <= registered_row_spacing
            <= CANONICAL_HEIGHT
            * tolerances["rowSpacingMaxRatio"]
        )
    )
    anchor_profile_applied = False
    block_point_sets = []
    for block_index, (region_left, region_right, _, _) in enumerate(definitions):
        block_points = circles[
            (circles[:, 0] >= region_left) & (circles[:, 0] <= region_right)
        ]
        if len(block_points) < 30:
            raise OmrRejected(
                f"Answer block {block_index + 1} is not fully visible",
                {
                    "block": block_index + 1,
                    "ringCandidates": int(len(block_points)),
                    "stage": "template-registration",
                    "geometryConfidence": 0.0,
                    "requiredGeometryConfidence": geometry_threshold,
                },
            )
        block_point_sets.append(block_points)

    # A periodic row profile can be shifted by an integer row when an edge is
    # faint. Evaluate neighboring phases against the full 2-D lattice and
    # choose the phase with the strongest unique ring and row support. Edge
    # support breaks ties only: prioritizing a few header/footer circles can
    # shift the entire lattice by two rows on a small camera image.
    # This remains stable when an off-centre/clipped page shifts the answer
    # region within normalized coordinates.
    phase_hypotheses = []
    for phase_offset in range(-3, 4):
        candidate_start = (
            shared_y_fit[1] + phase_offset * shared_y_fit[2]
        )
        if not (
            CANONICAL_HEIGHT * 0.10
            <= candidate_start
            <= CANONICAL_HEIGHT * 0.42
        ):
            continue
        candidate_y_fit = (
            shared_y_fit[0],
            candidate_start,
            shared_y_fit[2],
        )
        if row_anchor_available:
            (
                anchor_start_error_rows,
                anchor_end_error_rows,
                anchor_error_rows,
            ) = _row_profile_anchor_errors(
                candidate_start,
                shared_y_fit[2],
                registered_row_start,
                registered_row_spacing,
            )
            # A footer QR can put the first row near its nominal coordinate
            # while accumulating several rows of scale drift by row 25.
            # Absolute phase is therefore a whole-profile property.
        else:
            anchor_start_error_rows = 0.0
            anchor_end_error_rows = 0.0
            anchor_error_rows = 0.0
        expected_rows = (
            candidate_start
            + np.arange(25, dtype=np.float32) * shared_y_fit[2]
        )
        candidate_cell_support = 0
        candidate_row_support = 0
        candidate_edge_support = 0
        candidate_edge_rows = 0
        for block_index, block_points in enumerate(block_point_sets):
            x_fit = initial_x_fits[block_index]
            expected_x = (
                x_fit[1]
                + np.arange(4, dtype=np.float32) * x_fit[2]
            )
            x_distance_matrix = np.abs(
                block_points[:, 0, None] - expected_x[None, :]
            )
            y_distance_matrix = np.abs(
                block_points[:, 1, None] - expected_rows[None, :]
            )
            lanes = np.argmin(x_distance_matrix, axis=1)
            rows = np.argmin(y_distance_matrix, axis=1)
            point_indices = np.arange(len(block_points))
            accepted = (
                x_distance_matrix[point_indices, lanes]
                <= max(
                    CANONICAL_WIDTH * 0.008,
                    x_fit[2] * tolerances["assignmentXFraction"],
                )
            ) & (
                y_distance_matrix[point_indices, rows]
                <= max(
                    CANONICAL_HEIGHT * 0.0032,
                    shared_y_fit[2]
                    * tolerances["assignmentYFraction"],
                )
            )
            support = np.zeros((25, 4), dtype=np.uint8)
            support[rows[accepted], lanes[accepted]] = 1
            candidate_cell_support += int(support.sum())
            candidate_row_support += int(
                np.sum(support.sum(axis=1) >= 2)
            )
            candidate_edge_support += int(
                support[0].sum() + support[-1].sum()
            )
            candidate_edge_rows += int(support[0].sum() >= 2)
            candidate_edge_rows += int(support[-1].sum() >= 2)
        phase_hypotheses.append({
            "offset": phase_offset,
            "yFit": candidate_y_fit,
            "anchorErrorRows": anchor_error_rows,
            "anchorStartErrorRows": anchor_start_error_rows,
            "anchorEndErrorRows": anchor_end_error_rows,
            "edgeRows": candidate_edge_rows,
            "edgeCellSupport": candidate_edge_support,
            "score": (
                candidate_cell_support,
                candidate_row_support,
                candidate_edge_rows,
                candidate_edge_support,
                -round(anchor_error_rows, 6)
                if row_anchor_available
                else 0.0,
                -abs(phase_offset),
            ),
        })
    if not phase_hypotheses:
        raise OmrRejected(
            "No plausible row phase was found for the recovered bubble grid",
            {
                "stage": "row-column-estimation",
                "geometryConfidence": 0.0,
                "requiredGeometryConfidence": geometry_threshold,
            },
        )
    selectable_phase_hypotheses = phase_hypotheses
    phase_anchor_source = "registered-profile"
    if locator_method == "qr-anchor-lattice":
        # Repeated 25-row lattices have several high-support integer phases.
        # The fixed QR position supplies their absolute identity even when a
        # filled edge ring is not available as a circle candidate.
        best_anchored_phase = min(
            phase_hypotheses,
            key=lambda hypothesis: hypothesis["anchorErrorRows"],
        )
        if best_anchored_phase["anchorErrorRows"] > 0.30:
            best_edge_phase = max(
                phase_hypotheses,
                key=lambda hypothesis: hypothesis["score"],
            )
            raise OmrRejected(
                "QR-seeded answer grid drifts from the fixed row profile",
                {
                    "stage": "qr-grid-phase-verification",
                    "locator": locator_method,
                    "absoluteRowPhaseAnchored": False,
                    "rowPhaseAnchorErrorRows": round(
                        float(best_anchored_phase["anchorErrorRows"]), 4
                    ),
                    "rowPhaseStartErrorRows": round(
                        float(best_anchored_phase["anchorStartErrorRows"]),
                        4,
                    ),
                    "rowPhaseEndErrorRows": round(
                        float(best_anchored_phase["anchorEndErrorRows"]),
                        4,
                    ),
                    "bestEdgeRows": int(best_edge_phase["edgeRows"]),
                    "bestEdgeCellSupport": int(
                        best_edge_phase["edgeCellSupport"]
                    ),
                },
            )
        selectable_phase_hypotheses = [best_anchored_phase]
    best_phase = max(
        selectable_phase_hypotheses,
        key=lambda hypothesis: hypothesis["score"],
    )
    phase_adjustment = int(best_phase["offset"])
    phase_anchor_error_rows = float(
        best_phase.get("anchorErrorRows", 0.0)
    )
    phase_anchor_start_error_rows = float(
        best_phase.get("anchorStartErrorRows", 0.0)
    )
    phase_anchor_end_error_rows = float(
        best_phase.get("anchorEndErrorRows", 0.0)
    )
    shared_y_fit = best_phase["yFit"]
    blocks = []
    block_phase_recoveries = []
    for block_index, block_points in enumerate(block_point_sets):
        block_y_fit = shared_y_fit
        shared_support = _measure_lattice_support(
            block_points,
            initial_x_fits[block_index],
            shared_y_fit,
            tolerances,
        )

        # Perspective correction is projective, while a curled sheet is not.
        # When only one block loses an edge row, refit that block inside the
        # shared profile's phase.  Keeping the start within half a shared row
        # preserves question numbering while allowing mild page curl/shear to
        # move one answer block independently of the other.
        recovery = None
        if shared_support["edgeRows"] < 2:
            try:
                candidate_y_fit = _fit_periodic_profile(
                    lane_aligned_groups[block_index][:, 1],
                    CANONICAL_HEIGHT,
                    max(
                        CANONICAL_HEIGHT * 0.10,
                        shared_y_fit[1] - shared_y_fit[2] * 0.45,
                    ),
                    min(
                        CANONICAL_HEIGHT * 0.42,
                        shared_y_fit[1] + shared_y_fit[2] * 0.45,
                    ),
                    max(
                        CANONICAL_HEIGHT
                        * tolerances["rowSpacingMinRatio"],
                        shared_y_fit[2] * 0.92,
                    ),
                    min(
                        CANONICAL_HEIGHT
                        * tolerances["rowSpacingMaxRatio"],
                        shared_y_fit[2] * 1.08,
                    ),
                    25,
                )
                candidate_support = _measure_lattice_support(
                    block_points,
                    initial_x_fits[block_index],
                    candidate_y_fit,
                    tolerances,
                )
                if (
                    candidate_support["edgeRows"]
                    > shared_support["edgeRows"]
                    and candidate_support["rowSupport"]
                    >= shared_support["rowSupport"]
                    and candidate_support["cellSupport"]
                    >= shared_support["cellSupport"]
                ):
                    block_y_fit = candidate_y_fit
                    recovery = {
                        "offsetRows": round(
                            float(
                                (candidate_y_fit[1] - shared_y_fit[1])
                                / max(1.0, shared_y_fit[2])
                            ),
                            4,
                        ),
                        "sharedCellSupport": int(
                            shared_support["cellSupport"]
                        ),
                        "recoveredCellSupport": int(
                            candidate_support["cellSupport"]
                        ),
                        "sharedEdgeRows": int(
                            shared_support["edgeRows"]
                        ),
                        "recoveredEdgeRows": int(
                            candidate_support["edgeRows"]
                        ),
                    }
            except OmrRejected:
                recovery = None

        block_phase_recoveries.append(recovery)
        block_expected_rows = (
            block_y_fit[1]
            + np.arange(25, dtype=np.float32) * block_y_fit[2]
        )
        row_distance = np.min(
            np.abs(
                block_points[:, 1, None] - block_expected_rows[None, :]
            ),
            axis=1,
        )
        near_rows = block_points[
            row_distance
            <= max(
                CANONICAL_HEIGHT * 0.0032,
                block_y_fit[2] * tolerances["assignmentYFraction"],
            )
        ]
        refined = _refine_block_lattice(
            near_rows,
            block_y_fit,
            initial_x_fits[block_index],
            tolerances,
        )
        refined["profileY"] = [
            round(value, 5) for value in block_y_fit
        ]
        refined["rowPhaseRecovery"] = recovery
        refined["profileX"] = [
            round(value, 5) for value in initial_x_fits[block_index]
        ]
        refined["candidateCount"] = int(len(near_rows))
        # Sampling and overlays must use the actual, tilted ring positions.
        slope = lane_slopes[block_index]
        refined["centers"][:, :, 0] += slope * (
            refined["centers"][:, :, 1] - CANONICAL_HEIGHT * 0.5)
        refined["xCoefficients"][0] += slope * (refined["yCoefficients"][0] - CANONICAL_HEIGHT * 0.5)
        refined["xCoefficients"][1] += slope * refined["yCoefficients"][2]
        refined["xCoefficients"][2] += slope * refined["yCoefficients"][1]
        refined["laneTilt"] = slope
        blocks.append(refined)

    centers = np.concatenate((blocks[0]["centers"], blocks[1]["centers"]), axis=0)
    total_cell_support = blocks[0]["cellSupport"] + blocks[1]["cellSupport"]
    total_row_support = blocks[0]["rowSupport"] + blocks[1]["rowSupport"]
    valid_lane_groups = sum(
        1
        for block in blocks
        if sum(value >= 6 for value in block["laneSupport"]) >= 3
    )
    row_spacing_delta = abs(
        blocks[0]["yCoefficients"][1] - blocks[1]["yCoefficients"][1]
    )
    choice_spacings = [
        abs(float(block["xCoefficients"][1])) for block in blocks
    ]
    choice_spacing_ratio = min(choice_spacings) / max(
        1.0, max(choice_spacings)
    )
    top_row_delta = abs(
        blocks[0]["yCoefficients"][0] - blocks[1]["yCoefficients"][0]
    )
    left_last = float(np.max(blocks[0]["centers"][:, 3, 0]))
    right_first = float(np.min(blocks[1]["centers"][:, 0, 0]))

    cell_score = min(
        1.0, total_cell_support / tolerances["targetCellSupport"]
    )
    row_score = min(
        1.0, total_row_support / tolerances["targetRowSupport"]
    )
    mean_residual = float(
        np.mean([block["normalizedResidual"] for block in blocks])
    )
    residual_score = max(0.0, 1.0 - mean_residual / 1.2)
    lane_score = min(
        1.0,
        min(min(block["laneSupport"]) for block in blocks)
        / tolerances["targetLaneSupport"],
    )
    lane_group_score = valid_lane_groups / 2.0
    row_consistency_score = max(
        0.0, 1.0 - row_spacing_delta / max(1.0, shared_y_fit[2] * 0.16)
    )
    top_alignment_score = max(
        0.0, 1.0 - top_row_delta / max(1.0, shared_y_fit[2] * 0.62)
    )
    block_gap = right_first - left_last
    separation_score = min(
        1.0, max(0.0, block_gap / (CANONICAL_WIDTH * 0.09))
    )
    selected_edge_support = sum(
        int(block["support"][0].sum() + block["support"][-1].sum())
        for block in blocks
    )
    edge_phase_score = min(1.0, selected_edge_support / 16.0)
    unsupported_edge_rows = [
        block_index * 25 + row_index + 1
        for block_index, block in enumerate(blocks)
        for row_index in (0, 24)
        if int(block["support"][row_index].sum()) < 2
    ]
    unsupported_physical_edges = [
        edge_name
        for edge_name, row_index in (("top", 0), ("bottom", 24))
        if all(
            int(block["support"][row_index].sum()) < 2
            for block in blocks
        )
    ]
    registered_profile_anchor_error_rows = phase_anchor_error_rows
    physical_grid_edge_phase = (
        total_cell_support >= 160
        and total_row_support >= 46
        and min(int(block["rowSupport"]) for block in blocks) >= 22
        and selected_edge_support >= 10
        and not unsupported_physical_edges
        and (
            locator_method != "qr-anchor-lattice"
            or phase_anchor_error_rows <= 0.55
        )
    )
    if physical_grid_edge_phase:
        # With both physical edges and almost the complete 200-cell lattice
        # present, only one 25-row phase can explain both blocks.  This is
        # stronger absolute-row evidence than a marginal text homography and
        # remains valid on sheets whose print/camera scaling leaves the SIFT
        # template profile a fraction of a row away.
        phase_anchor_error_rows = 0.0
        phase_anchor_source = "complete-physical-grid-edges"
    absolute_phase_score = (
        max(0.0, 1.0 - phase_anchor_error_rows / 0.58)
        if row_anchor_available
        else 0.0
    )
    geometry_confidence = 100.0 * (
        0.25 * cell_score
        + 0.16 * row_score
        + 0.13 * residual_score
        + 0.09 * lane_score
        + 0.07 * lane_group_score
        + 0.07 * row_consistency_score
        + 0.05 * top_alignment_score
        + 0.05 * separation_score
        + 0.07 * edge_phase_score
        + 0.06 * absolute_phase_score
    )
    # An internal missing row is recoverable from neighbors. One answer block
    # can also recover its edge phase from the other block's shared physical
    # row. Only an edge unsupported in both blocks is unbracketed and must
    # lower the single acceptance score below the normal threshold.
    left_static_support = int(
        registration.get("leftStaticSupport") or 0
    )
    right_static_support = int(
        registration.get("rightStaticSupport") or 0
    )
    common_sift_phase_evidence = (
        locator_method == "sift-static-template-usac"
        and float(
            registration.get("medianReprojectionError") or 99.0
        )
        <= 1.0
        and not registration.get("questionsOutsideFrame")
    )
    sift_bilateral_phase = (
        common_sift_phase_evidence
        and float(registration.get("featureConfidence") or 0.0) >= 75.0
        and int(registration.get("inliers") or 0) >= 18
        and float(registration.get("templateYSpan") or 0.0) >= 950.0
        and min(left_static_support, right_static_support) >= 4
    )
    sift_unilateral_phase = (
        common_sift_phase_evidence
        and float(registration.get("featureConfidence") or 0.0) >= 78.0
        and int(registration.get("inliers") or 0) >= 24
        and float(registration.get("templateYSpan") or 0.0) >= 1100.0
        and max(left_static_support, right_static_support) >= 20
    )
    qr_grid_phase = (
        locator_method == "qr-grid-sift-usac"
        and registration.get("qrAnchorPresent") is True
        and float(registration.get("medianReprojectionError") or 99.0)
        <= 1.5
        and int(registration.get("inliers") or 0) >= 10
        and float(registration.get("templateYSpan") or 0.0) >= 900.0
        and min(left_static_support, right_static_support) >= 2
        and not registration.get("questionsOutsideFrame")
    )
    qr_anchor_lattice_phase = (
        locator_method == "qr-anchor-lattice"
        and registration.get("qrAnchorPresent") is True
        and not registration.get("questionsOutsideFrame")
        and phase_anchor_error_rows <= 0.30
    )
    phase_registration_evidence = (
        sift_bilateral_phase
        or sift_unilateral_phase
        or qr_grid_phase
        or qr_anchor_lattice_phase
        or physical_grid_edge_phase
        or (
            locator_method == "temporal-lk-usac"
            and float(registration.get("trackingConfidence") or 0.0)
            >= 55.0
            and int(registration.get("trackingInliers") or 0) >= 18
        )
        or (
            locator_method in (
                "otsu-paper-contour",
                "canny-paper-contour",
            )
            and not registration.get("clippedEdges")
        )
    )
    maximum_phase_error = 0.30
    phase_anchored = (
        physical_grid_edge_phase
        or (
            row_anchor_available
            and phase_registration_evidence
            and phase_anchor_error_rows <= maximum_phase_error
        )
    )
    if choice_spacing_ratio < 0.80:
        raise OmrRejected(
            "The two answer blocks disagree on A-D choice spacing",
            {
                "stage": "row-column-estimation",
                "locator": locator_method,
                "choiceSpacingRatio": round(choice_spacing_ratio, 4),
                "leftChoiceSpacing": round(choice_spacings[0], 4),
                "rightChoiceSpacing": round(choice_spacings[1], 4),
                "requiredChoiceSpacingRatio": 0.80,
                "geometryConfidence": round(float(geometry_confidence), 2),
                "requiredGeometryConfidence": geometry_threshold,
            },
        )
    edge_recovery_factor = 1.0
    if unsupported_physical_edges:
        edge_recovery_factor = 0.82 if phase_anchored else 0.40
        geometry_confidence *= edge_recovery_factor
    if geometry_confidence < geometry_threshold:
        raise OmrRejected(
            "Recovered bubble grid confidence is below the grading threshold",
            {
                "stage": "adaptive-grid-confidence",
                "geometryConfidence": round(float(geometry_confidence), 2),
                "requiredGeometryConfidence": geometry_threshold,
                "cellSupport": total_cell_support,
                "rowSupport": total_row_support,
                "normalizedResidual": round(mean_residual, 4),
                "validLaneGroups": valid_lane_groups,
                "rowSpacingDelta": round(float(row_spacing_delta), 4),
                "topRowDelta": round(float(top_row_delta), 4),
                "blockSeparation": round(float(block_gap), 4),
                "rowPhaseAdjustment": phase_adjustment,
                "rawRowStart": round(float(raw_shared_y_start), 4),
                "normalizedRowStart": round(float(shared_y_fit[1]), 4),
                "registeredRowStart": round(
                    float(registered_row_start), 4
                ),
                "registeredRowSpacing": round(
                    float(registered_row_spacing), 4
                ),
                "anchorConstrainedProfile": (
                    anchor_profile_applied
                ),
                "rowPhaseAnchorErrorRows": round(
                    phase_anchor_error_rows, 4
                ),
                "rowPhaseStartErrorRows": round(
                    phase_anchor_start_error_rows, 4
                ),
                "rowPhaseEndErrorRows": round(
                    phase_anchor_end_error_rows, 4
                ),
                "rowPhaseAnchorSource": phase_anchor_source,
                "registeredProfileAnchorErrorRows": round(
                    registered_profile_anchor_error_rows, 4
                ),
                "choiceSpacingRatio": round(choice_spacing_ratio, 4),
                "edgeCellSupport": selected_edge_support,
                "unsupportedEdgeRows": unsupported_edge_rows,
                "unsupportedPhysicalEdges": unsupported_physical_edges,
                "absoluteRowPhaseAnchored": phase_anchored,
                "edgeRecoveryFactor": edge_recovery_factor,
                "confidenceComponents": {
                    "cellSupport": round(cell_score, 4),
                    "rowSupport": round(row_score, 4),
                    "residual": round(residual_score, 4),
                    "laneSupport": round(lane_score, 4),
                    "laneGroups": round(lane_group_score, 4),
                    "rowConsistency": round(row_consistency_score, 4),
                    "topAlignment": round(top_alignment_score, 4),
                    "blockSeparation": round(separation_score, 4),
                    "edgePhaseSupport": round(edge_phase_score, 4),
                    "absoluteRowPhase": round(
                        absolute_phase_score, 4
                    ),
                },
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
    return centers, {
        "verified": True,
        "method": "normalized-adaptive-affine-clustering",
        "recoveredCells": 200 - total_cell_support,
        "cellSupport": total_cell_support,
        "rowSupport": total_row_support,
        "confidence": round(min(99.0, geometry_confidence), 2),
        "bubbleLocalizationConfidence": round(
            float(
                np.mean([
                    block["bubbleLocalizationConfidence"]
                    for block in blocks
                ])
            ),
            2,
        ),
        "requiredConfidence": geometry_threshold,
        "tolerances": {
            key: round(float(value), 5)
            for key, value in tolerances.items()
        },
        "confidenceComponents": {
            "cellSupport": round(cell_score, 4),
            "rowSupport": round(row_score, 4),
            "residual": round(residual_score, 4),
            "laneSupport": round(lane_score, 4),
            "laneGroups": round(lane_group_score, 4),
            "rowConsistency": round(row_consistency_score, 4),
            "topAlignment": round(top_alignment_score, 4),
            "blockSeparation": round(separation_score, 4),
            "edgePhaseSupport": round(edge_phase_score, 4),
            "absoluteRowPhase": round(absolute_phase_score, 4),
        },
        "rowPhaseAdjustment": phase_adjustment,
        "blockPhaseRecoveries": block_phase_recoveries,
        "rawRowStart": round(float(raw_shared_y_start), 4),
        "normalizedRowStart": round(float(shared_y_fit[1]), 4),
        "registeredRowStart": round(float(registered_row_start), 4),
        "registeredRowSpacing": round(
            float(registered_row_spacing), 4
        ),
        "anchorConstrainedProfile": anchor_profile_applied,
        "rowPhaseAnchorErrorRows": round(
            phase_anchor_error_rows, 4
        ),
        "rowPhaseStartErrorRows": round(
            phase_anchor_start_error_rows, 4
        ),
        "rowPhaseEndErrorRows": round(
            phase_anchor_end_error_rows, 4
        ),
        "rowPhaseAnchorSource": phase_anchor_source,
        "registeredProfileAnchorErrorRows": round(
            registered_profile_anchor_error_rows, 4
        ),
        "choiceSpacingRatio": round(choice_spacing_ratio, 4),
        "edgeCellSupport": selected_edge_support,
        "unsupportedEdgeRows": unsupported_edge_rows,
        "unsupportedPhysicalEdges": unsupported_physical_edges,
        "absoluteRowPhaseAnchored": phase_anchored,
        "edgeRecoveryFactor": edge_recovery_factor,
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
    adaptive_patches: List[np.ndarray] = []
    for row in range(50):
        for lane in range(4):
            x, y = (float(value) for value in centers[row, lane])
            if x < 16 or x > CANONICAL_WIDTH - 17 or y < 16 or y > CANONICAL_HEIGHT - 17:
                raise OmrRejected("A fitted answer bubble falls outside the visible page")
            patch = cv2.getRectSubPix(warped, (29, 29), (x, y))
            adaptive_patch = cv2.getRectSubPix(
                adaptive, (29, 29), (x - left, y - top)
            )
            patches.append(patch)
            adaptive_patches.append(adaptive_patch)
    # Keep identical subpixel samples, but calculate statistics for all 200
    # bubbles together instead of 200 small NumPy percentile/mean calls.
    samples = np.asarray(patches)
    inner = samples[:, _INNER_MASK]
    local_paper = np.percentile(samples[:, _CORNER_MASK], 75, axis=1)
    means = inner.mean(axis=1).reshape(50, 4).astype(np.float32)
    paper = local_paper.reshape(50, 4).astype(np.float32)
    adaptive_fill = (np.asarray(adaptive_patches)[:, _INNER_MASK] > 0).mean(axis=1).reshape(50, 4).astype(np.float32)
    dark_fraction = (inner < np.maximum(25.0, local_paper - 38.0)[:, None]).mean(axis=1).reshape(50, 4).astype(np.float32)
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


def _perceptual_header_hash(
    warped: np.ndarray,
    classification: Optional[Dict[str, Any]] = None,
) -> str:
    """Stable 64-bit composite identity for duplicate/new-sheet handling.

    The old hash covered only the immutable title and therefore identified
    every AcadCheck form as the same sheet.  The high 24 bits now describe
    high-pass content in the dynamic header/footer fields; the low 40 bits
    hash the classified 50x4 mark state.  Illumination normalization happens
    before this call, and the perceptual field component tolerates the small
    residual changes expected between adjacent webcam frames. The server uses
    the 24-bit field prefix to prove a physical replacement and the semantic
    suffix only to recognize stable repeats of that candidate.
    """

    dynamic_regions = (
        warped[250:488, 64:736],
        warped[2188:2395, 64:736],
    )
    field_views: List[np.ndarray] = []
    for region in dynamic_regions:
        background = cv2.GaussianBlur(
            region,
            (0, 0),
            sigmaX=9.0,
            sigmaY=9.0,
            borderType=cv2.BORDER_REPLICATE,
        )
        ink = cv2.subtract(background, region)
        field_views.append(
            cv2.resize(
                ink,
                (32, 16),
                interpolation=cv2.INTER_AREA,
            )
        )
    field_image = np.vstack(field_views).astype(np.float32)
    coefficients = cv2.dct(field_image)[:4, :6].reshape(-1)
    median = float(np.median(coefficients[1:]))
    field_bits = (coefficients >= median).astype(np.uint8)
    field_hash = np.packbits(field_bits).tobytes()[:3]

    row_states = (classification or {}).get("rowStates") or []
    marked_letters = (classification or {}).get("markedLetters") or []
    semantic_rows = []
    for row in range(50):
        state = str(row_states[row]) if row < len(row_states) else "?"
        letters = (
            "".join(str(value) for value in marked_letters[row])
            if row < len(marked_letters)
            else "?"
        )
        semantic_rows.append(f"{state}:{letters}")
    semantic_hash = hashlib.blake2s(
        "|".join(semantic_rows).encode("ascii", errors="replace"),
        digest_size=5,
        person=b"AcadOMR",
    ).digest()
    return (field_hash + semantic_hash).hex()


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


def _get_digit_net():
    global _DIGIT_NET, _DIGIT_LOAD_ATTEMPTED
    if _DIGIT_LOAD_ATTEMPTED:
        return _DIGIT_NET
    _DIGIT_LOAD_ATTEMPTED = True
    if not DIGIT_MODEL_PATH.exists():
        return None
    try:
        _DIGIT_NET = cv2.dnn.readNetFromONNX(str(DIGIT_MODEL_PATH))
    except Exception as error:  # pragma: no cover - availability is reported
        print(f'[FAST-OMR] Digit ONNX unavailable: {error}', file=sys.stderr, flush=True)
        _DIGIT_NET = None
    return _DIGIT_NET


def _sequence_field_candidate(
    crop: np.ndarray, box_count: int, wide_search: bool = False, canonical_page: bool = False
) -> Optional[Dict[str, int]]:
    height, width = crop.shape[:2]
    if canonical_page:
        # Search the full canonical page width so centered footer boxes cannot
        # be clipped by the old narrow x crop when a cut-out sheet is framed
        # differently. These fractions map the established footer profiles
        # from the former [17.5%, 90%] crop into full-page coordinates.
        left_fraction = 0.483 if box_count == 4 else 0.36
        width_fraction = 0.294 if box_count == 4 else 0.147
    else:
        left_fraction = 0.425 if box_count == 4 else 0.255
        width_fraction = 0.405 if box_count == 4 else 0.203
    otsu, _ = cv2.threshold(crop, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    dark = crop <= min(155, max(100, int(otsu) + 25))
    expanded_dark = cv2.dilate(
        dark.astype(np.uint8),
        np.ones((7, 1), dtype=np.uint8),
        borderType=cv2.BORDER_CONSTANT,
        borderValue=0,
    )
    # Prefix sums make each horizontal-border hypothesis constant-time per
    # row. Search the usual placement first, then tolerate printer/crop drift
    # only if no complete box lattice was found. Every divider still needs
    # independent vertical-line evidence; text alone cannot become an ID box.
    horizontal_sum = np.pad(
        np.cumsum(expanded_dark[8:height - 8], axis=1, dtype=np.int32),
        ((0, 0), (1, 0)),
    )
    # The native Android worker receives a perspective-normalized sheet, but
    # the sequence boxes on printed/cropped copies can sit noticeably farther
    # right and span more of the footer than the nominal template. Keep the
    # fast nominal pass; if it misses, search a wider bounded footer area.
    offsets = (
        (-0.015, 0.015, -0.03, 0.03, -0.045, 0.045, -0.06, 0.06, -0.08, 0.08, -0.10, 0.10, -0.12, 0.12)
        if wide_search else (0.0, -0.01, 0.01)
    )
    candidates: List[Dict[str, Any]] = []
    scales = (1.0, 0.96, 1.04, 0.92, 1.08) if not wide_search else (
        0.80, 0.90, 0.96, 1.0, 1.04, 1.12, 1.20, 1.30
    )
    for scale in scales:
        for offset in offsets:
            left = round(width * (left_fraction + offset))
            field_width = round(width * width_fraction * scale)
            right = left + field_width - 1
            if left < 16 or right >= width - 16:
                continue
            # Reduce the entire strip once instead of crossing the Python /
            # NumPy boundary for every pixel row of every field hypothesis.
            scores = (horizontal_sum[:, right + 1] - horizontal_sum[:, left]) / field_width
            rows = [(float(scores[index]), int(index) + 8)
                    for index in np.flatnonzero(scores >= 0.58)]
            rows.sort(reverse=True)
            peaks: List[Tuple[float, int]] = []
            for score, y in rows:
                if all(abs(y - existing_y) > 8 for _, existing_y in peaks):
                    peaks.append((score, y))
                    if len(peaks) >= 16:
                        break
            for first_score, top in peaks:
                for second_score, bottom in peaks:
                    field_height = bottom - top + 1
                    if bottom <= top or not round(height * 0.20) <= field_height <= round(height * 0.42):
                        continue
                    evidence = []
                    for boundary in range(box_count + 1):
                        x = round(left + (field_width - 1) * boundary / box_count)
                        row_slice = slice(top + 7, bottom - 6)
                        core = np.min(crop[row_slice, x - 3:x + 4], axis=1).astype(np.float32)
                        side_columns = [
                            x + dx
                            for dx in (-14, -13, -12, -11, -10, 10, 11, 12, 13, 14)
                            if 0 <= x + dx < width
                        ]
                        if not side_columns or core.size == 0:
                            evidence.append(0.0)
                            continue
                        sides = np.mean(crop[row_slice, side_columns], axis=1)
                        evidence.append(float(np.mean(sides - core > 18)))
                    if min(evidence) < 0.55:
                        continue
                    expected_height = height * 0.29
                    height_score = 1.0 - min(1.0, abs(field_height - expected_height) / expected_height)
                    candidates.append({
                        'left': left, 'right': right, 'top': top, 'bottom': bottom,
                        'width': field_width, 'height': field_height,
                        'score': (
                            first_score + second_score
                            + 2.0 * float(np.mean(evidence)) + height_score
                            # Prefer the nominal printed field when complete
                            # candidate lattices have similar line evidence;
                            # partial halves of a legacy four-box field often
                            # resemble a two-box field after broadening search.
                            - (abs(float(offset)) * 2.0 + abs(float(scale) - 1.0) * 0.45)
                        ),
                    })
    if candidates:
        return max(candidates, key=lambda item: float(item['score']))
    return None if wide_search else _sequence_field_candidate(
        crop, box_count, wide_search=True, canonical_page=canonical_page
    )


def _digit_patch_from_cell(cell: np.ndarray) -> Tuple[Optional[np.ndarray], bool]:
    height, width = cell.shape[:2]
    otsu, _ = cv2.threshold(cell, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    # Match the deployed digit preprocessing: retain faint strokes without
    # letting Otsu split nearly uniform paper noise into a false digit.
    threshold = min(205, max(80, int(otsu) + 12))
    ink = (cell <= threshold).astype(np.uint8)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(ink, 8)
    components = []
    minimum_area = max(5, int(width * height * 0.008))
    for label in range(1, count):
        x, y, component_width, component_height, area = stats[label]
        touches_edge = (
            x == 0 or y == 0
            or x + component_width >= width
            or y + component_height >= height
        )
        if (
            area >= minimum_area
            and component_height >= height * 0.24
            and component_width >= max(1, width * 0.055)
            and not (
                touches_edge
                and (component_width > width * 0.72 or component_height > height * 0.88)
            )
        ):
            components.append((label, int(area)))
    if not components:
        ink_count = int(np.count_nonzero(ink))
        return None, ink_count < max(3, int(cell.size * 0.002))
    largest_area = max(area for _, area in components)
    selected_labels = [label for label, area in components if area >= max(3, largest_area * 0.10)]
    selected = np.isin(labels, selected_labels)
    ys, xs = np.where(selected)
    min_x, max_x = int(np.min(xs)), int(np.max(xs))
    min_y, max_y = int(np.min(ys)), int(np.max(ys))
    ink_width = max_x - min_x + 1
    ink_height = max_y - min_y + 1
    side = max(20, int(math.ceil(max(ink_width, ink_height) * 1.42)))
    patch = np.full((side, side), 255, dtype=np.uint8)
    offset_x = (side - ink_width) // 2
    offset_y = (side - ink_height) // 2
    selected_crop = selected[min_y:max_y + 1, min_x:max_x + 1]
    source_crop = cell[min_y:max_y + 1, min_x:max_x + 1]
    target = patch[offset_y:offset_y + ink_height, offset_x:offset_x + ink_width]
    target[selected_crop] = np.minimum(source_crop[selected_crop], 35)
    return patch, False


def _classify_sequence_field(
    crop: np.ndarray,
    field: Dict[str, int],
    box_count: int,
    network: Any,
) -> Optional[Dict[str, Any]]:
    patches: List[Optional[np.ndarray]] = []
    for index in range(box_count):
        cell_left = round(field['left'] + field['width'] * index / box_count)
        cell_right = round(field['left'] + field['width'] * (index + 1) / box_count) - 1
        inset_x = max(2, int((cell_right - cell_left + 1) * 0.08))
        inset_y = max(2, int(field['height'] * 0.08))
        left = max(0, cell_left + inset_x)
        right = min(crop.shape[1] - 1, cell_right - inset_x)
        top = max(0, field['top'] + inset_y)
        bottom = min(crop.shape[0] - 1, field['bottom'] - inset_y)
        patch, blank = _digit_patch_from_cell(crop[top:bottom + 1, left:right + 1])
        if blank:
            patches.append(None)
            continue
        if patch is None:
            return None
        prepared = cv2.resize(patch, (32, 32), interpolation=cv2.INTER_AREA)
        prepared = cv2.normalize(prepared, None, 0, 255, cv2.NORM_MINMAX)
        sharpen = np.asarray([[0, -1, 0], [-1, 5, -1], [0, -1, 0]], dtype=np.float32)
        prepared = cv2.filter2D(prepared, -1, sharpen)
        patches.append(prepared)
    digit_patches = [patch for patch in patches if patch is not None]
    if not digit_patches:
        return None
    # OpenCV-DNN must keep a stable input shape between camera frames.
    # Dynamic batches can corrupt the persistent native network workspace.
    batch = np.ones((4, 1, 32, 32), dtype=np.float32)
    batch[:len(digit_patches)] = np.stack(digit_patches).reshape(-1, 1, 32, 32).astype(np.float32) / 255.0
    network.setInput(batch)
    probabilities = _softmax(np.asarray(network.forward(), dtype=np.float32).reshape(4, -1)[:len(digit_patches)])
    predictions = []
    for row in probabilities:
        digit = int(np.argmax(row))
        predictions.append((digit, float(row[digit])))
    prediction_index = 0
    readings: List[Optional[Tuple[int, float]]] = []
    for patch in patches:
        if patch is None:
            readings.append(None)
        else:
            readings.append(predictions[prediction_index])
            prediction_index += 1
    first_digit = next((index for index, item in enumerate(readings) if item is not None), -1)
    digits = readings[first_digit:] if first_digit >= 0 else []
    if not digits or any(item is None for item in digits):
        return None
    raw_digits = ''.join(str(item[0]) for item in digits if item)
    sequence = int(raw_digits)
    confidences = [item[1] for item in digits if item]
    if not 1 <= sequence <= 60:
        return None
    candidate = {
        'sequenceCandidate': str(sequence),
        'sequenceConfidence': round(min(96.0, 100.0 * float(np.mean(confidences)))),
        'sequenceRawDigits': raw_digits,
        'sequenceBoxCount': box_count,
        'sequenceDigitConfidences': [round(100.0 * value) for value in confidences],
    }
    if min(confidences) < 0.42 or float(np.mean(confidences)) < 0.58:
        return candidate
    return {**candidate, 'sequence': str(sequence)}


def _detect_student_sequence(warped: np.ndarray) -> Dict[str, Any]:
    network = _get_digit_net()
    if network is None or warped.shape[:2] != (CANONICAL_HEIGHT, CANONICAL_WIDTH):
        return {'sequence': None, 'sequenceConfidence': 0}
    crop_top = round(CANONICAL_HEIGHT * 0.865)
    crop_height = max(80, round(CANONICAL_HEIGHT * 0.134))
    # Keep the complete page width. The sequence field is centered on the
    # printed sheet, while the historical detector cropped at 17.5% and used
    # a second fixed x offset. That combination clipped or missed the boxes
    # when the camera's sheet crop moved by only a few percent.
    crop = warped[
        crop_top:min(CANONICAL_HEIGHT, crop_top + crop_height),
        :CANONICAL_WIDTH,
    ]
    crop = cv2.normalize(crop, None, 0, 255, cv2.NORM_MINMAX)
    # Compare the geometry of both supported layouts before reading any ink.
    # Searching the two-box layout first let the left half of a legacy 0003
    # field (plus footer text) masquerade as a valid two-digit student 11.
    # The strongest complete printed lattice identifies the sheet layout;
    # only that field is allowed to determine identity.
    fields = []
    for box_count in (2, 4):
        field = _sequence_field_candidate(crop, box_count, canonical_page=True)
        if field is not None:
            fields.append((float(field.get('score', 0.0)), box_count, field))
    if not fields:
        return {'sequence': None, 'sequenceConfidence': 0}
    _, box_count, field = max(fields, key=lambda item: item[0])
    result = _classify_sequence_field(crop, field, box_count, network)
    return result or {'sequence': None, 'sequenceConfidence': 0}


def _cnn_probabilities(patches: Sequence[np.ndarray]) -> Optional[np.ndarray]:
    network = _get_cnn_net()
    if network is None or not patches:
        return None
    # A fixed 200-cell batch avoids a native OpenCV-DNN crash when successive
    # sheets change from one uncertain row to several blank/multiple rows.
    # White padding is ignored in the returned predictions.
    prepared = np.ones((200, 1, 32, 32), dtype=np.float32)
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
    return output[:len(patches), 1]


def _classify_rows(
    means: np.ndarray,
    paper: np.ndarray,
    adaptive_fill: np.ndarray,
    dark_fraction: np.ndarray,
    patches: Sequence[np.ndarray],
    use_cnn: bool,
) -> Dict[str, Any]:
    # The compact center statistic is stable around printed rings, while a
    # larger interior catches answers shaded mainly toward one side. Keep this
    # as independent evidence: the wider disk includes more printed glyph ink
    # and therefore must agree with the CNN before it can recover a mark.
    wide_means = np.asarray(patches)[:, _WIDE_INNER_MASK].mean(axis=1).reshape(50, 4)
    wide_lane_baseline = np.vstack((
        np.percentile(wide_means[:25], 75, axis=0),
        np.percentile(wide_means[25:], 75, axis=0),
    )).astype(np.float32)
    expanded_wide_baseline = np.vstack((
        np.repeat(wide_lane_baseline[0:1], 25, axis=0),
        np.repeat(wide_lane_baseline[1:2], 25, axis=0),
    ))
    wide_darkness = expanded_wide_baseline - wide_means
    wide_row_exposure = np.mean(np.sort(wide_darkness, axis=1)[:, :2], axis=1)
    wide_relative_darkness = wide_darkness - wide_row_exposure[:, None]
    # The form prints A/B/C/D inside every ring. Those glyphs have different
    # darkness (B is consistently darkest), so comparing the four raw means in
    # one row creates false B marks on an otherwise blank sheet. Calibrate that
    # fixed printed ink per lane across the sheet, then remove the row exposure
    # level using the two lightest cells. This leaves only added pencil/pen ink.
    # Calibrate the two physical 25-row blocks independently.  Their x
    # positions are far apart, so combining them makes a left-to-right light
    # gradient look like an answer mark even though local paper exposure is
    # stable within each block.
    lane_baseline = np.vstack((
        np.percentile(means[:25], 75, axis=0),
        np.percentile(means[25:], 75, axis=0),
    )).astype(np.float32)
    expanded_lane_baseline = np.vstack((
        np.repeat(lane_baseline[0:1], 25, axis=0),
        np.repeat(lane_baseline[1:2], 25, axis=0),
    ))
    lane_darkness = expanded_lane_baseline - means
    row_exposure = np.mean(np.sort(lane_darkness, axis=1)[:, :2], axis=1)
    normalized_darkness = lane_darkness - row_exposure[:, None]
    adaptive_lane_baseline = np.vstack((
        np.percentile(adaptive_fill[:25], 25, axis=0),
        np.percentile(adaptive_fill[25:], 25, axis=0),
    )).astype(np.float32)
    expanded_adaptive_baseline = np.vstack((
        np.repeat(adaptive_lane_baseline[0:1], 25, axis=0),
        np.repeat(adaptive_lane_baseline[1:2], 25, axis=0),
    ))
    adaptive_excess = adaptive_fill - expanded_adaptive_baseline
    adaptive_row_level = np.mean(np.sort(adaptive_excess, axis=1)[:, :2], axis=1)
    normalized_adaptive_excess = adaptive_excess - adaptive_row_level[:, None]
    global_threshold, clustering = _two_cluster_threshold(-normalized_darkness)
    global_mark = (
        -normalized_darkness < global_threshold
        if global_threshold is not None
        else np.zeros_like(means, dtype=bool)
    )
    local_contrast = paper - means
    cell_threshold, cell_clustering = _two_cluster_threshold(means)
    # A normal one-answer sheet has roughly one dark cell per four-cell row.
    # Reject a split that labels most of the printed A-D glyph population as
    # "marks"; those apparent clusters are letter-shape, not added ink.
    if (
        cell_threshold is not None
        and float(cell_clustering["darkFraction"]) <= 0.45
    ):
        cell_cluster_mark = means < cell_threshold
    else:
        cell_threshold = None
        cell_clustering["usable"] = False
        cell_cluster_mark = np.zeros_like(means, dtype=bool)

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
        relative = normalized_darkness[row]
        order = np.argsort(relative)[::-1]
        top_gap = float(relative[order[0]] - relative[order[1]])
        spread = float(np.max(relative) - np.min(relative))
        # Absolute grayscale thresholds are deliberately excluded: camera
        # exposure can move an unmarked bubble from 210 to 110 without
        # changing its meaning.  Marks need both row-relative separation and,
        # near the boundary, membership in the sheet's dark cluster.
        # Adaptive-threshold fill is especially useful for faint pencil over
        # the already-dark printed B/D glyphs. Its lane/row normalization has
        # a clean margin on blank generated forms, while preserving pale marks.
        adaptive_mark = normalized_adaptive_excess[row] >= 0.18
        adaptive_possible = normalized_adaptive_excess[row] >= 0.16
        absolute_cluster_mark = cell_cluster_mark[row]
        relative_strong = (
            (relative >= 30.0)
            | adaptive_mark
            | ((relative >= 18.0) & global_mark[row])
        )
        relative_possible = (
            (relative >= 18.0)
            | adaptive_possible
            | global_mark[row]
        )
        if cell_threshold is not None:
            cluster_separation = float(cell_clustering["separation"])
            added_ink_evidence = (
                (local_contrast[row] >= 48.0)
                | (dark_fraction[row] >= 0.58)
                | (normalized_adaptive_excess[row] >= 0.30)
            )
            strong = absolute_cluster_mark | (
                relative_strong
                & added_ink_evidence
                & (
                    row_means
                    < cell_threshold + 0.20 * cluster_separation
                )
            )
            possible = absolute_cluster_mark | (
                relative_possible
                & (relative >= 30.0)
                & added_ink_evidence
                & (
                    row_means
                    < cell_threshold + 0.40 * cluster_separation
                )
            )
        else:
            strong = relative_strong
            possible = relative_possible
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
            row_confidence = min(99.0, max(72.0, 58.0 + 0.55 * top_gap))
            if cell_threshold is not None and bool(absolute_cluster_mark[selected]):
                intensity_order = np.argsort(row_means)
                intensity_gap = float(
                    row_means[intensity_order[1]] - row_means[intensity_order[0]]
                )
                absolute_confidence = (
                    72.0
                    + 0.12 * min(100.0, max(0.0, intensity_gap))
                    + 10.0 * float(np.clip(
                        (dark_fraction[row, selected] - 0.55) / 0.40, 0.0, 1.0
                    ))
                    + 5.0 * float(np.clip(
                        (local_contrast[row, selected] - 45.0) / 55.0, 0.0, 1.0
                    ))
                )
                row_confidence = max(row_confidence, min(99.0, absolute_confidence))
            confidence[row] = row_confidence
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
                "adaptiveExcess": [
                    round(float(value), 4)
                    for value in normalized_adaptive_excess[row]
                ],
                "darkFraction": [
                    round(float(value), 4) for value in dark_fraction[row]
                ],
                "localContrast": [
                    round(float(value), 3) for value in local_contrast[row]
                ],
                "cellClusterMark": [
                    bool(value) for value in absolute_cluster_mark
                ],
                "topGap": round(top_gap, 3),
                "cvPossibleCount": len(possible_indices),
            }
        )

    ai_checked_rows = 0
    ai_resolved_rows = 0
    single_lane_counts = np.zeros(4, dtype=np.int32)
    for row, state in enumerate(states):
        if state == "single" and answers[row] in CHOICES:
            single_lane_counts[CHOICES.index(answers[row])] += 1
    dominant_lane = int(np.argmax(single_lane_counts))
    uniform_lane_consensus = (
        int(single_lane_counts[dominant_lane]) >= 45
        and int(np.sum(single_lane_counts)) >= 45
    )
    # A classical "blank" is still a negative assertion: a weak mark can be
    # suppressed by lane calibration, glare, or an edge-row warp. Audit every
    # blank alongside uncertain rows in one CNN batch. A blank is accepted only
    # when the CNN also sees no mark; disagreement becomes uncertain and blocks
    # automatic grading instead of silently counting a visible answer wrong.
    cnn_rows = sorted(set(
        uncertain_rows
        + [row for row, state in enumerate(states) if state == "blank"]
    ))
    if use_cnn and cnn_rows:
        ambiguous_patches: List[np.ndarray] = []
        for row in cnn_rows:
            ambiguous_patches.extend(patches[row * 4 : row * 4 + 4])
        probabilities = _cnn_probabilities(ambiguous_patches)
        if probabilities is not None:
            probabilities = probabilities.reshape(len(cnn_rows), 4)
            ai_checked_rows = len(cnn_rows)
            still_uncertain: List[int] = []
            for result_index, row in enumerate(cnn_rows):
                row_probabilities = probabilities[result_index]
                ranked = np.argsort(row_probabilities)[::-1]
                selected = int(ranked[0])
                second = int(ranked[1])
                intensity_order = np.argsort(means[row])
                classical = int(intensity_order[0])
                relative_gap = float(
                    np.partition(relative_darkness[row], -2)[-1]
                    - np.partition(relative_darkness[row], -2)[-2]
                )
                intensity_gap = float(
                    means[row, intensity_order[1]]
                    - means[row, intensity_order[0]]
                )
                top_gap = max(relative_gap, intensity_gap)
                cnn_marks = np.flatnonzero(row_probabilities >= 0.90).tolist()
                extra_possible = [
                    index
                    for index in np.flatnonzero(possible_masks[row]).tolist()
                    if index != selected
                ]
                # A warped/blurred printed ring sometimes produces a weak
                # 18-28 level "possible" candidate. Permit the CNN to suppress
                # it only when three independent ring-artifact features agree.
                # Faint second marks fail these gates and remain uncertain.
                only_ring_artifact_extras = bool(extra_possible) and all(
                    relative_darkness[row, index] < 42.0
                    and dark_fraction[row, index] >= 0.40
                    and (
                        dark_fraction[row, index]
                        / max(0.0001, adaptive_fill[row, index])
                    )
                    >= 0.62
                    and row_probabilities[index] <= 0.04
                    for index in extra_possible
                )
                diagnostics[row]["cnnMarkedProbability"] = [
                    round(float(value), 5) for value in row_probabilities
                ]
                wide_order = np.argsort(wide_relative_darkness[row])[::-1]
                wide_selected = int(wide_order[0])
                wide_top = float(wide_relative_darkness[row, wide_selected])
                wide_gap = float(
                    wide_relative_darkness[row, wide_selected]
                    - wide_relative_darkness[row, int(wide_order[1])]
                )
                partial_shading_rescue = bool(
                    selected == wide_selected
                    and possible_counts[row] <= 1
                    and float(dark_fraction[row, selected]) >= 0.25
                    and (
                        (
                            wide_top >= 30.0
                            and wide_gap >= 15.0
                            and float(row_probabilities[selected]) >= 0.025
                            and float(row_probabilities[second]) <= 0.05
                        )
                        or (
                            wide_top >= 14.0
                            and wide_gap >= 6.0
                            and float(row_probabilities[selected]) >= 0.07
                            and float(row_probabilities[second]) <= 0.03
                        )
                    )
                )
                diagnostics[row]["wideRelativeDarkness"] = [
                    round(float(value), 3)
                    for value in wide_relative_darkness[row]
                ]
                diagnostics[row]["partialShadingRescue"] = partial_shading_rescue
                # On an intentionally uniform answer sheet, the lane baseline
                # contains marks in all 25 calibration rows. One unusually
                # pale but real mark can therefore lose row-relative contrast
                # after a tight crop even though the other 49 rows, the CNN,
                # and its local ink features all agree. Recover only that
                # narrow case; a possible competing mark or weak/blank patch
                # remains uncertain.
                uniform_consensus_rescue = bool(
                    uniform_lane_consensus
                    and selected == dominant_lane
                    and selected == classical
                    and possible_counts[row] == 0
                    and float(row_probabilities[selected]) >= 0.60
                    and (
                        float(row_probabilities[second]) <= 0.10
                        or (
                            # A cropped warp can give printed glyphs a small
                            # nonzero model score. Require a decisive model
                            # margin AND raw ink contrast before recovering it.
                            float(row_probabilities[selected]) >= 0.90
                            and float(row_probabilities[selected] - row_probabilities[second]) >= 0.80
                            and intensity_gap >= 60.0
                        )
                    )
                    and float(dark_fraction[row, selected]) >= 0.55
                    and float(local_contrast[row, selected]) >= 42.0
                )
                diagnostics[row]["uniformLaneConsensusRescue"] = (
                    uniform_consensus_rescue
                )
                if (
                    (
                        len(cnn_marks) == 1
                        and (
                            possible_counts[row] <= 1
                            or only_ring_artifact_extras
                        )
                        and selected == classical
                        and row_probabilities[selected] >= (
                            0.90
                            if (
                                float(dark_fraction[row, selected]) >= 0.72
                                and float(local_contrast[row, selected]) >= 55.0
                            )
                            else 0.94
                        )
                        and row_probabilities[second] <= 0.20
                        and top_gap >= 12.0
                    )
                    or uniform_consensus_rescue
                    or partial_shading_rescue
                ):
                    answers[row] = CHOICES[selected]
                    marked_letters[row] = [CHOICES[selected]]
                    states[row] = "single"
                    if uniform_consensus_rescue or partial_shading_rescue:
                        confidence[row] = min(
                            90.0,
                            max(
                                75.0,
                                60.0
                                + 25.0 * float(row_probabilities[selected])
                                + 0.15 * min(top_gap, 40.0),
                            ),
                        )
                    else:
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
                    (
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
                    )
                    or (
                        float(np.max(row_probabilities)) <= 0.80
                        and intensity_gap <= 35.0
                        and float(np.max(relative_darkness[row])) <= 28.0
                        and float(np.max(dark_fraction[row])) <= 0.50
                        and float(
                            np.max(normalized_adaptive_excess[row])
                        ) <= 0.28
                    )
                ):
                    marked_letters[row] = []
                    states[row] = "blank"
                    confidence[row] = 90.0
                    ai_resolved_rows += 1
                else:
                    states[row] = "uncertain"
                    confidence[row] = 0.0
                    likely_lanes = set(
                        np.flatnonzero(possible_masks[row]).tolist()
                    )
                    if float(row_probabilities[selected]) >= 0.50:
                        likely_lanes.add(selected)
                    marked_letters[row] = [
                        CHOICES[index]
                        for index in sorted(likely_lanes)
                    ]
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
        "featureClustering": {
            **clustering,
            "cellIntensity": cell_clustering,
            "laneBaseline": [
                [round(float(value), 3) for value in block]
                for block in lane_baseline
            ],
            "adaptiveLaneBaseline": [
                [round(float(value), 4) for value in block]
                for block in adaptive_lane_baseline
            ],
        },
        "aiVerification": {
            "model": "onnx-bubble-classifier",
            "mode": "uncertain-and-blank-rows-batched",
            "available": _get_cnn_net() is not None if use_cnn and cnn_rows else MODEL_PATH.exists(),
            "checkedRows": ai_checked_rows,
            "resolvedRows": ai_resolved_rows,
        },
        "rowDiagnostics": diagnostics,
    }


def _ring_samples(warped: np.ndarray, centers: np.ndarray) -> np.ndarray:
    # Compare the printed ring area, excluding the central answer mark. Local
    # mean/variance normalization tolerates exposure changes between frames.
    yy, xx = np.mgrid[-20:21:2, -20:21:2]
    mask = (xx * xx + yy * yy >= 100) & (xx * xx + yy * yy <= 400)
    flat = np.asarray(centers, dtype=np.float32).reshape(200, 2)
    smooth = cv2.GaussianBlur(warped, (3, 3), 0)
    return cv2.remap(smooth, flat[:, :1] + xx[mask].astype(np.float32)[None, :],
                    flat[:, 1:] + yy[mask].astype(np.float32)[None, :],
                    cv2.INTER_LINEAR).astype(np.float32)


def _ink_signature(warped: np.ndarray, centers: np.ndarray) -> np.ndarray:
    yy, xx = np.mgrid[-6:7:2, -6:7:2]
    mask = xx * xx + yy * yy <= 36
    flat = np.asarray(centers, dtype=np.float32).reshape(200, 2)
    core = cv2.remap(warped, flat[:, :1] + xx[mask].astype(np.float32)[None, :],
                    flat[:, 1:] + yy[mask].astype(np.float32)[None, :], cv2.INTER_LINEAR)
    paper = np.percentile(_ring_samples(warped, centers), 75, axis=1)
    return (paper - core.mean(axis=1)) * 220 / np.maximum(40, paper)


def _verify_tracked_grid(warped, verified_grid, tolerances):
    """Verify current printed ring patches against a fully accepted grid."""
    started = time.perf_counter()
    centers, previous_geometry, reference_rings, _ = verified_grid
    if (np.shape(centers) != (50, 4, 2)
            or previous_geometry.get("absoluteRowPhaseAnchored") is not True
            or previous_geometry.get("tolerances") != {key: round(float(value), 5) for key, value in tolerances.items()}):
        return None
    flat = np.asarray(centers, dtype=np.float32).reshape(200, 2)
    if (np.min(flat[:, 0]) < 20 or np.max(flat[:, 0]) >= warped.shape[1] - 20
            or np.min(flat[:, 1]) < 20 or np.max(flat[:, 1]) >= warped.shape[0] - 20):
        return None
    current = _ring_samples(warped, centers)
    reference = reference_rings - reference_rings.mean(axis=1, keepdims=True)
    current -= current.mean(axis=1, keepdims=True)
    reference_std = np.sqrt(np.mean(reference * reference, axis=1))
    current_std = np.sqrt(np.mean(current * current, axis=1))
    correlation = np.mean(reference * current, axis=1) / np.maximum(1, reference_std * current_std)
    # Filled bubbles can cover part of the printed ring and reduce annulus
    # texture. Six levels still rejects erased/white regions, while retaining
    # enough ring evidence for uniform-answer sheets to use the fast path.
    support = ((correlation >= .70) & (current_std >= 6) & (reference_std >= 6)).reshape(50, 4)
    cells = int(support.sum())
    # Verify all question rows, both blocks and each edge on the current image.
    # Changed/erased marks are still classified from scratch after this gate.
    if (cells < 170 or np.min(support.sum(axis=1)) < 3
            or min(np.min(support[:25].sum(axis=0)), np.min(support[25:].sum(axis=0))) < 18):
        return None
    confidence = min(float(previous_geometry["confidence"]), cells / 2)
    if confidence < tolerances["minimumGeometryConfidence"]:
        return None
    geometry = dict(previous_geometry)
    geometry.update(method="tracked-current-ring-verification", cellSupport=cells,
                    rowSupport=50, recoveredCells=200-cells,
                    confidence=confidence,
                    bubbleLocalizationConfidence=round(float(np.mean(np.clip(correlation, 0, 1))) * 100, 2),
                    edgeCellSupport=int(support[[0,24,25,49]].sum()),
                    unsupportedEdgeRows=[], unsupportedPhysicalEdges=[],
                    processingMs=0.0)
    geometry["blocks"] = [dict(block, cellSupport=int(support[index*25:(index+1)*25].sum()),
                               rowSupport=25,
                               rowCellSupport=support[index*25:(index+1)*25].sum(axis=1).tolist(),
                               laneSupport=support[index*25:(index+1)*25].sum(axis=0).tolist())
                          for index, block in enumerate(previous_geometry.get("blocks", []))]
    left, top, right, bottom = ANSWER_ROI
    adaptive = cv2.adaptiveThreshold(warped[top:bottom, left:right], 255,
                                    cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 31, 8)
    circles = np.column_stack((flat[support.reshape(-1)], np.full(cells, 14))).astype(np.float32)
    return circles, adaptive, {"method": "tracked-current-ring-verification", "bubbleCandidates": cells,
                               "processingMs": _stage_ms(started)}, centers.copy(), geometry


def _evaluate_registered_sheet(
    warped: np.ndarray,
    geometry_tolerances: Dict[str, float],
    placement: Optional[Dict[str, Any]] = None,
) -> Tuple[
    np.ndarray,
    np.ndarray,
    Dict[str, Any],
    np.ndarray,
    Dict[str, Any],
]:
    """Validate one registration candidate using current-sheet ring evidence."""

    verified_grid = placement.pop("_verifiedGrid", None) if placement else None
    if verified_grid is not None and placement.get("trackingConfidence", 0) >= 75:
        fast = _verify_tracked_grid(warped, verified_grid, geometry_tolerances)
        if fast is not None:
            return fast
    circles, adaptive, locator_details = _find_bubble_candidates(
        warped, geometry_tolerances
    )
    grid_started = time.perf_counter()
    centers, geometry = _fit_answer_grid(
        circles, geometry_tolerances, placement
    )
    geometry["processingMs"] = _stage_ms(grid_started)
    return circles, adaptive, locator_details, centers, geometry


def scan_image(image_bytes: bytes, options: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    options = dict(options or {})
    started = time.perf_counter()
    stages: Dict[str, float] = {}
    timing_details: Dict[str, Any] = {
        "stagesAreExclusive": True,
        "registrationRoutesMs": {},
        "opencvThreads": int(cv2.getNumThreads()),
    }
    trace: List[Dict[str, Any]] = []
    placement: Optional[Dict[str, Any]] = None
    gray: Optional[np.ndarray] = None
    current_stage = "decode"
    debug_dir = Path(options["debugDir"]) if options.get("debugDir") else None
    geometry_tolerances = _resolve_geometry_tolerances(options)
    try:
        decode_started = time.perf_counter()
        encoded = np.frombuffer(image_bytes, dtype=np.uint8)
        # Decode once. JPEG decoder-level half sampling can move faint ring
        # edges enough to change a row decision relative to the same camera
        # frame resized by the preview. Area resizing gives both paths the
        # same pixel geometry while retaining full detail on smaller frames.
        gray = cv2.imdecode(encoded, cv2.IMREAD_GRAYSCALE)
        decodeScale = 1.0
        if gray is not None and gray.size >= 6000000:
            decodeScale = 1440.0 / max(gray.shape)
            gray = cv2.resize(gray, None, fx=decodeScale, fy=decodeScale, interpolation=cv2.INTER_AREA)
        if gray is None or gray.size == 0:
            raise OmrRejected("Image could not be decoded")
        stages["decode"] = _stage_ms(decode_started)
        trace.append({
            "stage": "decode",
            "status": "ok",
            "shape": list(gray.shape),
            "sourceDecodeScale": decodeScale,
        })
        qr_anchor: Optional[np.ndarray] = None
        try:
            supplied_anchor = np.asarray(
                options.get("qrAnchorCorners"), dtype=np.float32
            ).reshape(4, 2)
            if np.isfinite(supplied_anchor).all():
                qr_anchor = supplied_anchor * float(decodeScale)
        except (TypeError, ValueError):
            qr_anchor = None

        current_stage = "registration"
        page_started = time.perf_counter()
        registration_attempts: List[Dict[str, Any]] = []
        locator_errors: List[OmrRejected] = []
        selected: Optional[
            Tuple[
                np.ndarray,
                Dict[str, Any],
                np.ndarray,
                np.ndarray,
                Dict[str, Any],
                np.ndarray,
                Dict[str, Any],
            ]
        ] = None

        def try_candidates(
            candidates: Sequence[Tuple[np.ndarray, Dict[str, Any]]]
        ) -> bool:
            nonlocal selected
            for candidate_warped, candidate_placement in candidates:
                attempt_started = time.perf_counter()
                locator_name = str(
                    candidate_placement.get("locator") or "registration"
                )
                required_confidence = (
                    52.0
                    if locator_name == "temporal-lk-usac"
                    else QR_LATTICE_MIN_REGISTRATION_CONFIDENCE
                    if locator_name == "answer-ring-lattice"
                    else REFERENCE_FRAME_MIN_REGISTRATION_CONFIDENCE
                    if locator_name == "reference-frame-sift-usac"
                    else QR_LATTICE_MIN_REGISTRATION_CONFIDENCE
                    if locator_name == "qr-anchor-lattice"
                    else QR_GRID_MIN_REGISTRATION_CONFIDENCE
                    if locator_name == "qr-grid-sift-usac"
                    else SIFT_MIN_REGISTRATION_CONFIDENCE
                    if locator_name == "sift-static-template-usac"
                    else 65.0
                )
                actual_confidence = candidate_placement.get(
                    "registrationConfidence",
                    candidate_placement.get("confidence"),
                )
                try:
                    numeric_confidence = float(actual_confidence)
                except (TypeError, ValueError):
                    numeric_confidence = float("-inf")
                if (
                    candidate_placement.get("acceptable") is not True
                    or not math.isfinite(numeric_confidence)
                    or numeric_confidence < required_confidence
                ):
                    candidate_error = OmrRejected(
                        (
                            f"{locator_name} confidence "
                            f"{max(0.0, numeric_confidence):.2f}% is below "
                            f"the required {required_confidence:.2f}%"
                        ),
                        {
                            "stage": (
                                "tracking"
                                if locator_name == "temporal-lk-usac"
                                else "template-registration"
                            ),
                            "locator": locator_name,
                            "registrationConfidence": actual_confidence,
                            "requiredRegistrationConfidence": (
                                required_confidence
                            ),
                            "failingGate": (
                                "minimum-registration-confidence"
                            ),
                        },
                    )
                    locator_errors.append(candidate_error)
                    registration_attempts.append({
                        "locator": locator_name,
                        "status": "failed",
                        "registrationConfidence": actual_confidence,
                        "requiredRegistrationConfidence": (
                            required_confidence
                        ),
                        "reason": candidate_error.reason,
                        "stage": candidate_error.details["stage"],
                        "metrics": candidate_error.details,
                        "processingMs": _stage_ms(attempt_started),
                    })
                    continue
                try:
                    (
                        candidate_circles,
                        candidate_adaptive,
                        candidate_locator,
                        candidate_centers,
                        candidate_geometry,
                    ) = _evaluate_registered_sheet(
                        candidate_warped,
                        geometry_tolerances,
                        candidate_placement,
                    )
                    if (
                        locator_name
                        in (
                            "qr-grid-sift-usac",
                            "qr-anchor-lattice",
                            "sift-static-template-usac",
                            "temporal-lk-usac",
                            "reference-frame-sift-usac",
                        )
                        and candidate_geometry.get(
                            "absoluteRowPhaseAnchored"
                        ) is not True
                    ):
                        raise OmrRejected(
                            "QR-guided registration could not prove the absolute question-row phase",
                            {
                                "stage": "qr-grid-phase-verification",
                                "locator": locator_name,
                                "absoluteRowPhaseAnchored": False,
                                "rowPhaseAnchorErrorRows": candidate_geometry.get(
                                    "rowPhaseAnchorErrorRows"
                                ),
                                "recommendation": (
                                    "Hold the complete answer sheet steady and keep "
                                    "the first and last answer rows visible."
                                ),
                            },
                        )
                    registration_attempts.append({
                        "locator": candidate_placement.get("locator"),
                        "status": "ok",
                        "registrationConfidence": candidate_placement.get(
                            "registrationConfidence",
                            candidate_placement.get("confidence"),
                        ),
                        "geometryConfidence": candidate_geometry.get(
                            "confidence"
                        ),
                        "bubbleLocalizationConfidence": candidate_geometry.get(
                            "bubbleLocalizationConfidence"
                        ),
                        "processingMs": _stage_ms(attempt_started),
                    })
                    selected = (
                        candidate_warped,
                        candidate_placement,
                        candidate_circles,
                        candidate_adaptive,
                        candidate_locator,
                        candidate_centers,
                        candidate_geometry,
                    )
                    return True
                except OmrRejected as candidate_error:
                    locator_errors.append(candidate_error)
                    registration_attempts.append({
                        "locator": candidate_placement.get("locator"),
                        "status": "failed",
                        "registrationConfidence": candidate_placement.get(
                            "registrationConfidence",
                            candidate_placement.get("confidence"),
                        ),
                        "reason": candidate_error.reason,
                        "stage": candidate_error.details.get("stage"),
                        "metrics": candidate_error.details,
                        "processingMs": _stage_ms(attempt_started),
                    })
            return False

        contour_error: Optional[OmrRejected] = None
        tracking_started = time.perf_counter()
        tracked = _try_tracked_registration(gray, options)
        if tracked is not None:
            try_candidates([tracked])
        timing_details["registrationRoutesMs"][
            "tracking"
        ] = _stage_ms(tracking_started)

        if selected is None and not options.get("_requireFreshRegistration"):
            reference_started = time.perf_counter()
            reference_candidates = _reference_frame_registration_candidates(
                gray, options
            )
            if reference_candidates:
                try_candidates(reference_candidates)
            timing_details["registrationRoutesMs"][
                "reference"
            ] = _stage_ms(reference_started)

        # A valid temporal update already carries the last accepted canonical
        # transform. Do not rerun page contours or feature matching until its
        # current-frame bubble validation or confidence gate fails.
        if (
            selected is None
            and qr_anchor is not None
        ):
            # The browser deliberately sends live previews with a 1440-pixel
            # long edge.  Small landscape frames are decoded at full size
            # above (their half-resolution short edge falls below 700), so a
            # 1400-pixel guard silently disabled the QR-guided registrar on
            # every normal camera request.  The registrar already bounds its
            # work to a QR-relative ROI and caps that crop at 1080 pixels;
            # therefore it is both safe and cheaper to run it at any source
            # resolution whenever a validated current-frame QR anchor exists.
            qr_grid_started = time.perf_counter()
            qr_grid_candidates = _qr_grid_registration_candidates(
                gray, qr_anchor, debug_dir
            )
            if qr_grid_candidates:
                try_candidates(qr_grid_candidates)
            else:
                registration_attempts.append({
                    "locator": "qr-grid-sift-usac",
                    "status": "failed",
                    "reason": "QR-guided grid registration found no robust homography",
                    "stage": "qr-grid-registration",
                })
            timing_details["registrationRoutesMs"][
                "qrGrid"
            ] = _stage_ms(qr_grid_started)

            if selected is None:
                qr_lattice_started = time.perf_counter()
                qr_lattice_candidates = (
                    _qr_anchor_lattice_registration_candidates(
                        gray, qr_anchor
                    )
                )
                if qr_lattice_candidates:
                    try_candidates(qr_lattice_candidates)
                else:
                    registration_attempts.append({
                        "locator": "qr-anchor-lattice",
                        "status": "failed",
                        "reason": (
                            "QR-seeded ring-lattice recovery could not be initialized"
                        ),
                        "stage": "qr-grid-registration",
                    })
                timing_details["registrationRoutesMs"][
                    "qrLattice"
                ] = _stage_ms(
                    qr_lattice_started
                )

        # Outline warps can fit a plausible periodic grid one lane off when
        # the page is tilted. Prefer immutable printed-content registration
        # in a rectified paper crop before trusting the optional outline.
        oriented = _oriented_paper_content(gray) if selected is None else None
        oriented_attempted = False

        def try_oriented_content() -> None:
            nonlocal oriented_attempted
            oriented_started = time.perf_counter()
            if oriented is not None and not oriented_attempted:
                oriented_attempted = True
                try:
                    # In landscape camera frames printed text fixes A-D
                    # identity before the periodic ring lattice is fitted.
                    # Already rectified portrait scans retain the ring route
                    # to avoid a second resampling of faint answer strokes.
                    if gray.shape[0] >= gray.shape[1] and oriented[2].get("method") == "answer-ring-axis-content" and oriented[2]["axisTiltDeg"] <= 8.0:
                        try_candidates(_ring_lattice_registration_candidates(gray, oriented))
                    if selected is None:
                        try_candidates(_feature_registration_candidates(
                            gray, debug_dir, prepared_content=oriented))
                except OmrRejected as error:
                    locator_errors.append(error)
                    registration_attempts.append({
                        "locator": "oriented-paper-content", "status": "failed",
                        "reason": error.reason, "metrics": error.details,
                    })
                if selected is None and oriented[2].get("method") == "answer-ring-axis-content" and oriented[2]["axisTiltDeg"] <= 8.0:
                    try:
                        try_candidates(_ring_lattice_registration_candidates(gray, oriented))
                    except OmrRejected as error:
                        locator_errors.append(error)
                        registration_attempts.append({
                            "locator": "answer-ring-lattice", "status": "failed",
                            "reason": error.reason, "metrics": error.details,
                        })
            timing_details["registrationRoutesMs"]["orientedContent"] = _stage_ms(oriented_started)

        contour_attempted = False

        def try_outline_content() -> None:
            nonlocal contour_error, contour_attempted
            if contour_attempted or selected is not None:
                return
            contour_attempted = True
            try:
                try:
                    contour_candidate = _locate_and_warp(gray)
                except OmrRejected as error:
                    if (error.details.get("stage") != "content-registration-required"
                            or error.details.get("sourceOrientation") != "sideways"):
                        raise
                    contour_error = error
                    # Clipped paper is never accepted as complete geometry. Its
                    # rectified crop can still reveal the immutable print, whose
                    # source homography must pass every visibility and row gate.
                    contour_candidate = _locate_and_warp(gray, allow_clipped=True)
                # A rotated outline cannot distinguish A-D from D-A or fix
                # absolute row identity. Require printed-template evidence.
                if (abs(float(contour_candidate[1].get("rotationDeg", 0))) > 8.0
                        or contour_candidate[1].get("sourceOrientation") == "sideways"):
                    contour_warped, contour_placement = contour_candidate
                    printed_started = time.perf_counter()
                    try_candidates(_feature_registration_candidates(gray, debug_dir,
                        prepared_content=(contour_warped,
                            np.asarray(contour_placement["perspectiveTransform"], dtype=np.float64),
                            {"method": "outline-bounded-fixed-print",
                             "axisTiltDeg": abs(float(contour_placement["rotationDeg"]))})))
                    timing_details["registrationRoutesMs"]["outlineFixedPrint"] = _stage_ms(printed_started)
                else:
                    try_candidates([contour_candidate])
            except OmrRejected as error:
                contour_error = error
                registration_attempts.append({
                    "locator": "paper-contour",
                    "status": "bypassed"
                    if error.details.get("stage")
                    == "content-registration-required"
                    else "failed",
                    "reason": error.reason,
                    "metrics": error.details,
                })

        # When the contour confirms that the page itself is clipped, use the
        # already-computed ring-axis crop before spending time on progressively
        # wider background-heavy SIFT searches. Upright clipped pages benefit
        # from the tighter crop even though no angular correction is needed.
        # Retain the inexpensive, established outline route for upright
        # sheets. The extra resampling is useful primarily for rotation.
        if oriented is not None and oriented[2]["axisTiltDeg"] > 8.0:
            # A complete outline cheaply bounds the fixed-print search. Try
            # that before a ring-axis crop can select the wrong diagonal band.
            try_outline_content()
            if selected is None:
                try_oriented_content()

        if selected is None:
            try_outline_content()

        if (
            selected is None
            and not oriented_attempted
            and oriented is not None
            and contour_error is not None
            and contour_error.details.get("stage")
            == "content-registration-required"
        ):
            try_oriented_content()

        feature_started: Optional[float] = None
        if selected is None:
            feature_started = time.perf_counter()
            # A verified QR supplies a high-detail crop for distant sheets.
            # On no-QR landscape frames, try the normal narrow-paper crop
            # first. Only if it fails, widen the same detected bright core by
            # two bounded tilt margins. Every resulting homography must still
            # pass projection, two-block, absolute-row, and 50x4-grid gates.
            feature_attempts = (
                (
                    (qr_anchor, None),
                    (None, None),
                    (None, 0.12),
                    (None, 0.15),
                )
                if qr_anchor is not None
                else (
                    (None, None),
                    (None, 0.12),
                    (None, 0.15),
                )
            )
            for feature_anchor, rotation_margin_ratio in feature_attempts:
                if selected is not None:
                    break
                try:
                    feature_candidates = _feature_registration_candidates(
                        gray,
                        debug_dir,
                        feature_anchor,
                        rotation_margin_ratio,
                    )
                    try_candidates(feature_candidates)
                except OmrRejected as error:
                    locator_errors.append(error)
                    registration_attempts.append({
                        "locator": "sift-static-template-usac",
                        "status": "failed",
                        "reason": error.reason,
                        "metrics": error.details,
                    })
            timing_details["registrationRoutesMs"][
                "feature"
            ] = _stage_ms(feature_started)

        if selected is None and not oriented_attempted:
            try_oriented_content()

        if selected is None:
            best_error = (
                locator_errors[-1]
                if locator_errors
                else contour_error
            )
            reason = (
                best_error.reason
                if best_error is not None
                else "The answer area could not be registered"
            )
            failure_details = (
                dict(best_error.details)
                if best_error is not None
                else {}
            )
            accepted_registration_evidence = any(
                attempt.get("locator")
                in (
                    "answer-ring-lattice",
                    "sift-static-template-usac",
                    "qr-grid-sift-usac",
                    "qr-anchor-lattice",
                    "temporal-lk-usac",
                    "reference-frame-sift-usac",
                    "otsu-paper-contour",
                    "canny-paper-contour",
                )
                and attempt.get("registrationConfidence") is not None
                and float(attempt["registrationConfidence"])
                >= (
                    52.0
                    if attempt.get("locator")
                    == "temporal-lk-usac"
                    else QR_LATTICE_MIN_REGISTRATION_CONFIDENCE
                    if attempt.get("locator")
                    == "answer-ring-lattice"
                    else REFERENCE_FRAME_MIN_REGISTRATION_CONFIDENCE
                    if attempt.get("locator")
                    == "reference-frame-sift-usac"
                    else QR_LATTICE_MIN_REGISTRATION_CONFIDENCE
                    if attempt.get("locator")
                    == "qr-anchor-lattice"
                    else QR_GRID_MIN_REGISTRATION_CONFIDENCE
                    if attempt.get("locator")
                    == "qr-grid-sift-usac"
                    else SIFT_MIN_REGISTRATION_CONFIDENCE
                    if attempt.get("locator")
                    == "sift-static-template-usac"
                    else 65.0
                )
                for attempt in registration_attempts
            )
            failure_details.update({
                "stage": failure_details.get(
                    "stage", "template-registration"
                ),
                "outlineRequired": False,
                "registrationAttempts": registration_attempts,
                "sheetPresence": failure_details.get(
                    "sheetPresence",
                    (
                        "present"
                        if accepted_registration_evidence
                        else "indeterminate"
                    ),
                ),
                "answerContentDetected": failure_details.get(
                    "answerContentDetected",
                    True if accepted_registration_evidence else None,
                ),
                "presenceConfidence": failure_details.get(
                    "presenceConfidence",
                    95.0 if accepted_registration_evidence else 0.0,
                ),
                "recommendation": failure_details.get(
                    "recommendation",
                    (
                        "Keep all 50 question rows and both A-D answer columns visible. "
                        "The outer paper border and page corners may remain outside the frame."
                    ),
                ),
            })
            raise OmrRejected(reason, failure_details)

        (
            warped,
            placement,
            circles,
            adaptive,
            locator_details,
            centers,
            geometry,
        ) = selected
        stages["registration"] = _stage_ms(page_started)
        timing_details.update({
            "selectedRegistrationRoute": placement.get("locator"),
            "gridVerificationMethod": geometry.get("method"),
            "candidateValidationMs": round(
                sum(
                    float(attempt.get("processingMs", 0.0))
                    for attempt in registration_attempts
                ),
                3,
            ),
            "bubbleDetectionMs": float(
                locator_details.get("processingMs", 0.0)
            ),
            "gridFittingMs": float(
                geometry.get("processingMs", 0.0)
            ),
            "nestedTimingNote": (
                "Registration route and candidate-validation timings are "
                "diagnostic nested spans; only stagesMs is additive."
            ),
        })

        current_stage = "lighting-normalization"
        lighting_started = time.perf_counter()
        normalized_warped, lighting_metrics = _normalize_lighting(
            warped
        )
        answer_left, answer_top, answer_right, answer_bottom = ANSWER_ROI
        normalized_answer_roi = normalized_warped[
            answer_top:answer_bottom,
            answer_left:answer_right,
        ]
        classification_adaptive = cv2.adaptiveThreshold(
            normalized_answer_roi,
            255,
            cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
            cv2.THRESH_BINARY_INV,
            31,
            8,
        )
        classification_adaptive = cv2.morphologyEx(
            classification_adaptive,
            cv2.MORPH_OPEN,
            np.ones((2, 2), dtype=np.uint8),
            iterations=1,
        )
        stages["lightingNormalization"] = _stage_ms(
            lighting_started
        )

        quad = np.asarray(placement.get("corners", []), dtype=np.int32)
        # Full-page color overlays are diagnostic-only. Building them before
        # _debug_write checked debug_dir wasted tens of milliseconds on every
        # production scan even though the images were immediately discarded.
        if debug_dir is not None:
            outline = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
            if quad.shape == (4, 2):
                cv2.polylines(outline, [quad], True, (0, 255, 0), 8)
                for index, point in enumerate(quad):
                    cv2.circle(outline, tuple(point), 18, (0, 0, 255), -1)
                    cv2.putText(
                        outline, str(index + 1), tuple(point + (20, 0)),
                        cv2.FONT_HERSHEY_SIMPLEX, 1.2, (0, 0, 255), 3,
                    )
            else:
                cv2.putText(
                    outline,
                    "Paper outline optional - registered from visible answer content",
                    (24, 52),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.72,
                    (0, 220, 0),
                    2,
                    cv2.LINE_AA,
                )
            _debug_write(
                debug_dir, "01_document_outline_and_corners", outline
            )
            _debug_write(debug_dir, "02_warped_sheet", warped)
            _debug_write(
                debug_dir,
                "02a_lighting_normalized_sheet",
                normalized_warped,
            )
        trace.append({
            "stage": "document-detection",
            "status": "ok",
            "outlineRequired": False,
            "pageOutlineDetected": quad.shape == (4, 2),
            "locator": placement.get("locator"),
            "coverage": placement.get("coverage"),
            "clippedEdges": (
                (contour_error.details or {}).get("clippedEdges")
                if contour_error is not None
                else placement.get("clippedEdges")
            ),
        })
        trace.append({
            "stage": "corner-detection",
            "status": "ok" if quad.shape == (4, 2) else "optional-bypassed",
            "required": False,
            "corners": placement.get("corners"),
        })
        trace.append({
            "stage": "feature-matching",
            "status": "ok"
            if placement.get("locator")
            in (
                "sift-static-template-usac",
                "reference-frame-sift-usac",
            )
            else "not-needed",
            "matches": placement.get("featureMatches"),
            "inliers": placement.get("inliers"),
            "medianReprojectionError": placement.get(
                "medianReprojectionError"
            ),
        })
        trace.append({
            "stage": "tracking",
            "status": "ok"
            if placement.get("locator")
            in (
                "temporal-lk-usac",
                "reference-frame-sift-usac",
            )
            else "not-used",
            "confidence": placement.get("trackingConfidence"),
            "inliers": placement.get("trackingInliers"),
        })
        trace.append({
            "stage": "perspective-transform",
            "status": "ok",
            "method": placement.get("locator"),
            "canonicalSize": placement.get("canonicalSize"),
            "templateAlignmentError": placement.get(
                "templateAlignmentError"
            ),
        })
        trace.append({
            "stage": "lighting-normalization",
            "status": "ok",
            **lighting_metrics,
        })
        trace.append({
            "stage": "fiducial-marker-detection",
            "status": "not-present-on-v1",
            "required": False,
            "reason": (
                "The current v1 form has no dedicated fiducials; fixed print "
                "and the bubble lattice provide registration."
            ),
        })

        if debug_dir is not None:
            _debug_write(
                debug_dir, "03_detected_bubble_centers",
                _draw_candidates_only(warped, circles),
            )
            _debug_write(
                debug_dir, "04_expected_grid_overlay",
                _draw_expected_template(warped),
            )
            _debug_write(
                debug_dir,
                "05_actual_fitted_grid_overlay",
                _draw_fitted_template(warped, centers, geometry),
            )
            _debug_write(
                debug_dir,
                "06_mismatched_locations_highlighted",
                _draw_grid_debug(warped, circles, centers),
            )
            _debug_write(
                debug_dir,
                "07_bubble_localization_confidence_heatmap",
                _draw_localization_heatmap(warped, centers, geometry),
            )
        trace.append({
            "stage": "bubble-grid-localization",
            "status": "ok",
            **locator_details,
        })
        trace.append({
            "stage": "template-registration",
            "status": "ok",
            "registrationConfidence": placement.get(
                "registrationConfidence",
                placement.get("confidence"),
            ),
            "templateAlignmentError": placement.get(
                "templateAlignmentError"
            ),
            "cellSupport": geometry.get("cellSupport"),
            "rowSupport": geometry.get("rowSupport"),
            "attempts": registration_attempts,
        })
        trace.append({
            "stage": "alignment",
            "status": "ok",
            "method": geometry.get("method"),
            "geometryConfidence": geometry.get("confidence"),
            "requiredConfidence": geometry.get("requiredConfidence"),
            "bubbleLocalizationConfidence": geometry.get(
                "bubbleLocalizationConfidence"
            ),
            "recoveredCells": geometry.get("recoveredCells"),
        })
        trace.append({
            "stage": "row-column-estimation",
            "status": "ok",
            "rows": 50,
            "columns": 4,
        })
        trace.append({
            "stage": "template-matching",
            "status": "ok",
            "layout": FORM_LAYOUT,
            "templateId": placement.get("templateId"),
        })

        current_stage = "mark-classification"
        feature_started = time.perf_counter()
        means, paper, adaptive_fill, dark_fraction, patches = _extract_features(
            normalized_warped, classification_adaptive, centers
        )
        stages["featureExtraction"] = _stage_ms(feature_started)
        classify_started = time.perf_counter()
        classification = _classify_rows(
            means,
            paper,
            adaptive_fill,
            dark_fraction,
            patches,
            bool(options.get("useCnn", True)),
        )
        stages["classification"] = _stage_ms(classify_started)
        assembly_started = time.perf_counter()
        mark_confidences = np.asarray(
            classification["confidenceScores"], dtype=np.float32
        )
        average_confidence = float(np.mean(mark_confidences)) if len(mark_confidences) else 0.0
        quality_metrics = _build_quality_metrics(
            lighting_metrics,
            geometry,
            placement,
            classification,
            average_confidence,
        )
        tracking_update_started = time.perf_counter()
        if quality_metrics.get("gradeable") is True:
            previous_entry = _TRACKING_CACHE.get(_tracking_key(options))
            _update_tracking_cache(gray, options, placement)
            entry = _TRACKING_CACHE.get(_tracking_key(options))
            if entry is not None and entry is not previous_entry and geometry.get("absoluteRowPhaseAnchored") is True:
                entry["verifiedGrid"] = (centers.copy(), dict(geometry), _ring_samples(warped, centers), _ink_signature(warped, centers))
        stages["trackingUpdate"] = _stage_ms(tracking_update_started)
        # Keep stage timings exclusive (cache maintenance is reported above).
        assembly_started += stages["trackingUpdate"] / 1000.0
        sheet_fingerprint = _perceptual_header_hash(
            normalized_warped, classification
        )
        if bool(options.get('detectSequence', False)):
            sequence_result = _detect_student_sequence(normalized_warped)
            quality_metrics.update(sequence_result)
        serialized_centers = [
            [
                [round(float(x), 3), round(float(y), 3)]
                for x, y in centers[row]
            ]
            for row in range(50)
        ]
        overlay_geometry = None
        if bool(options.get("includeOverlayGeometry", False)):
            try:
                source_to_canonical = np.asarray(
                    placement.get("perspectiveTransform"),
                    dtype=np.float64,
                ).reshape(3, 3)
                canonical_to_source = np.linalg.inv(source_to_canonical)
                source_centers = cv2.perspectiveTransform(
                    centers.reshape(-1, 1, 2).astype(np.float32),
                    canonical_to_source,
                ).reshape(50, 4, 2)
                source_scale = max(1e-6, float(decodeScale))
                source_centers /= source_scale
                source_width = int(round(gray.shape[1] / source_scale))
                source_height = int(round(gray.shape[0] / source_scale))
                if (
                    source_width > 0
                    and source_height > 0
                    and np.isfinite(source_centers).all()
                ):
                    overlay_geometry = {
                        "width": source_width,
                        "height": source_height,
                        "centers": [
                            [
                                [round(float(x), 2), round(float(y), 2)]
                                for x, y in source_centers[row]
                            ]
                            for row in range(50)
                        ],
                    }
            except (
                TypeError,
                ValueError,
                np.linalg.LinAlgError,
                cv2.error,
            ):
                overlay_geometry = None
        row_diagnostics = (
            classification["rowDiagnostics"]
            if bool(options.get("includeDiagnostics", False))
            else None
        )
        diagnostic_artifacts = _debug_artifacts(debug_dir)
        stages["resultAssembly"] = _stage_ms(assembly_started)
        total_ms = _stage_ms(started)
        stages["overhead"] = round(
            max(0.0, total_ms - sum(stages.values())),
            3,
        )
        return {
            "success": True,
            "source": "fast-hybrid-grid",
            "formLayout": FORM_LAYOUT,
            "answers": classification["answers"],
            "confidenceScores": classification["confidenceScores"],
            "markedLetters": classification["markedLetters"],
            "rowStates": classification["rowStates"],
            "averageConfidence": round(average_confidence, 2),
            "qualityMetrics": quality_metrics,
            "geometryVerified": True,
            "gradeable": quality_metrics["gradeable"],
            "sheetPresence": "present",
            "answerContentDetected": True,
            "presenceConfidence": 100.0,
            "currentSheetGeometry": True,
            "geometryConfidence": geometry["confidence"],
            "registrationConfidence": placement.get(
                "registrationConfidence",
                placement.get("confidence"),
            ),
            "templateAlignmentError": placement.get(
                "templateAlignmentError"
            ),
            "bubbleLocalizationConfidence": geometry.get(
                "bubbleLocalizationConfidence"
            ),
            "blankRows": classification["blankRows"],
            "ambiguousRows": classification["multipleRows"],
            "multipleRows": classification["multipleRows"],
            "uncertainRows": classification["uncertainRows"],
            "uncertainRowNumbers": classification["uncertainRowNumbers"],
            "markedRows": classification["markedRows"],
            "placement": placement,
            "sheetFingerprint": sheet_fingerprint,
            "sheetFingerprintVersion": 2,
            "grid": geometry,
            "locator": locator_details,
            "featureClustering": classification["featureClustering"],
            "aiVerification": classification["aiVerification"],
            "rowDiagnostics": row_diagnostics,
            "centers": serialized_centers,
            "overlayGeometry": overlay_geometry,
            "processingMs": total_ms,
            "stagesMs": stages,
            "timingDetails": timing_details,
            "stageTrace": trace,
            "diagnosticArtifacts": diagnostic_artifacts,
        }
    except OmrRejected as error:
        details = dict(error.details)
        failure_stage = details.get("stage") or current_stage
        details["stage"] = failure_stage
        details.setdefault("sheetPresence", "indeterminate")
        details.setdefault("answerContentDetected", None)
        details.setdefault("presenceConfidence", 0.0)
        if not any(stage.get("status") == "failed" for stage in trace):
            trace.append({
                "stage": failure_stage,
                "status": "failed",
                "reason": error.reason,
                "metrics": error.details,
            })
        if debug_dir is not None and gray is not None:
            rejected = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
            cv2.rectangle(rejected, (10, 10), (min(1550, rejected.shape[1] - 10), 90), (20, 20, 20), -1)
            cv2.putText(
                rejected,
                f"Rejected at {failure_stage}: {error.reason}"[:150],
                (25, 62),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.8,
                (255, 255, 255),
                2,
                cv2.LINE_AA,
            )
            _debug_write(debug_dir, "00_rejected_input_and_reason", rejected)
        if placement is not None and "placement" not in details:
            details["placement"] = placement
        return {
            "success": False,
            "source": "fast-hybrid-grid-rejected",
            "formLayout": FORM_LAYOUT,
            "reason": error.reason,
            "geometryVerified": False,
            "sheetPresence": "indeterminate",
            "answerContentDetected": None,
            "presenceConfidence": 0.0,
            "answers": [],
            "confidenceScores": [],
            "markedLetters": [],
            "processingMs": _stage_ms(started),
            "stagesMs": stages,
            "timingDetails": timing_details,
            "stageTrace": trace,
            "diagnosticArtifacts": _debug_artifacts(debug_dir),
            **details,
        }
    except Exception as error:  # fail closed, but keep a useful diagnostic
        failure_reason = f"Fast OMR failed: {error}"
        trace.append({
            "stage": current_stage,
            "status": "failed",
            "reason": failure_reason,
        })
        if debug_dir is not None and gray is not None:
            rejected = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
            cv2.putText(
                rejected,
                f"Error at {current_stage}: {error}"[:150],
                (25, 62),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.8,
                (255, 255, 255),
                2,
                cv2.LINE_AA,
            )
            _debug_write(debug_dir, "00_rejected_input_and_reason", rejected)
        return {
            "success": False,
            "source": "fast-hybrid-grid-error",
            "formLayout": FORM_LAYOUT,
            "reason": failure_reason,
            "stage": current_stage,
            "geometryVerified": False,
            "answers": [],
            "confidenceScores": [],
            "markedLetters": [],
            "processingMs": _stage_ms(started),
            "stagesMs": stages,
            "timingDetails": timing_details,
            "stageTrace": trace,
            "placement": placement,
            "diagnosticArtifacts": _debug_artifacts(debug_dir),
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
    parser.add_argument(
        "--runtime-info", action="store_true", help="Print bundled runtime versions as JSON"
    )
    parser.add_argument("--no-cnn", action="store_true", help="Disable ambiguous-row CNN")
    parser.add_argument(
        "--diagnostics", action="store_true", help="Include per-row feature diagnostics"
    )
    parser.add_argument(
        "--debug-dir",
        help="Write page, warp, bubble-center, recovered-grid, and rejection images",
    )
    args = parser.parse_args()
    if args.runtime_info:
        print(json.dumps({
            "pythonVersion": platform.python_version(),
            "openCvVersion": cv2.__version__,
            "numpyVersion": np.__version__,
        }))
        return 0
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
        {
            "useCnn": not args.no_cnn,
            "includeDiagnostics": args.diagnostics,
            "debugDir": args.debug_dir,
        },
    )
    print(json.dumps(result, indent=2))
    return 0 if result.get("success") else 1


if __name__ == "__main__":
    raise SystemExit(main())
