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
MODEL_PATH = Path(__file__).resolve().parents[1] / "backend" / "models" / "bubble-classifier.onnx"
REGISTRATION_TEMPLATE_DIR = (
    Path(__file__).resolve().parent
    / "registration_templates"
    / "acadcheck-50-v1"
)
REGISTRATION_MANIFEST_PATH = REGISTRATION_TEMPLATE_DIR / "manifest.json"

_INNER_Y, _INNER_X = np.ogrid[-14:15, -14:15]
_INNER_MASK = (_INNER_X * _INNER_X + _INNER_Y * _INNER_Y) <= 8 * 8
_CORNER_MASK = (np.abs(_INNER_X) >= 10) & (np.abs(_INNER_Y) >= 10)
_PROFILE_COORD_CACHE: Dict[int, np.ndarray] = {}
_CNN_NET = None
_CNN_LOAD_ATTEMPTED = False
_REGISTRATION_TEMPLATES: Optional[List[Dict[str, Any]]] = None
_REGISTRATION_TEMPLATE_ERROR: Optional[str] = None
_REGISTRATION_STATIC_MASK_IMAGE: Optional[np.ndarray] = None
_TRACKING_CACHE: "OrderedDict[str, Dict[str, Any]]" = OrderedDict()
_TRACKING_TTL_SECONDS = 5.0
_TRACKING_CACHE_LIMIT = 8
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
    # The public result remains in canonical form coordinates, so original
    # corner coordinates are not consumed by the grading code.
    if paper_width > paper_height * 1.08:
        rotated = cv2.rotate(gray, cv2.ROTATE_90_CLOCKWISE)
        warped, placement = _locate_and_warp(
            rotated, allow_clipped=allow_clipped
        )
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
                "id": str(item.get("id") or f"reference-{index + 1}"),
                "primary": str(
                    item.get("id") or f"reference-{index + 1}"
                ) == primary_template_id,
                "image": image,
                "points": points.reshape(-1, 2),
                "descriptors": descriptors,
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


def _provisional_content_roi(
    gray: np.ndarray,
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


def _feature_registration_candidates(
    gray: np.ndarray,
    debug_dir: Optional[Path] = None,
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

    content, content_offset, content_details = _provisional_content_roi(
        gray
    )
    scale = min(1.0, 1000.0 / max(content.shape))
    if scale < 1.0:
        small = cv2.resize(
            content,
            None,
            fx=scale,
            fy=scale,
            interpolation=cv2.INTER_AREA,
        )
    else:
        small = content
    detector = cv2.SIFT_create(
        nfeatures=2200,
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
    required_registration_confidence = 48.0
    source_to_small = np.asarray(
        [
            [scale, 0.0, -scale * content_offset[0]],
            [0.0, scale, -scale * content_offset[1]],
            [0.0, 0.0, 1.0],
        ],
        dtype=np.float64,
    )
    for template in templates:
        pairs = matcher.knnMatch(
            template["descriptors"], target_descriptors, k=2
        )
        ratio_matches = [
            first
            for pair in pairs
            if len(pair) == 2
            for first, second in [pair]
            if first.distance < 0.80 * second.distance
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
        if inlier_count < 8:
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
        if inlier_count < 10:
            failed_gates.append({
                "gate": "minimum-inlier-count",
                "observed": inlier_count,
                "requiredMinimum": 10,
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
            and min(left_support, right_support) >= 4
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
    if entry is None or tuple(entry.get("sourceShape", ())) != tuple(gray.shape):
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
    if (
        current.shape != entry["small"].shape
        or abs(current_scale - float(entry["smallScale"])) > 1e-6
    ):
        _TRACKING_CACHE.pop(key, None)
        return None
    previous_points = np.asarray(entry.get("points"), dtype=np.float32)
    if previous_points.ndim != 3 or len(previous_points) < 24:
        _TRACKING_CACHE.pop(key, None)
        return None
    current_points, status, flow_error = cv2.calcOpticalFlowPyrLK(
        entry["small"],
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
        @ scale_matrix
    )
    source_to_canonical = (
        np.asarray(entry["sourceToCanonical"], dtype=np.float64)
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
    points = cv2.goodFeaturesToTrack(
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
    _TRACKING_CACHE[key] = {
        "updatedAt": time.monotonic(),
        "frameId": frame_id,
        "sourceShape": tuple(gray.shape),
        "small": small.copy(),
        "smallScale": scale,
        "points": points,
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
    tolerances = tolerances or DEFAULT_GEOMETRY_TOLERANCES
    left, top, right, bottom = ANSWER_ROI
    roi = warped[top:bottom, left:right]
    p10, p90 = np.percentile(roi, [10, 90])
    local_range = float(p90 - p10)
    clahe_used = local_range < 82.0
    locator_roi = roi
    if clahe_used:
        locator_roi = cv2.createCLAHE(clipLimit=1.6, tileGridSize=(8, 8)).apply(roi)

    smooth = cv2.GaussianBlur(locator_roi, (3, 3), 0)
    minimum_radius = max(
        5, round(CANONICAL_WIDTH * tolerances["bubbleRadiusMinRatio"])
    )
    maximum_radius = max(
        minimum_radius + 3,
        round(CANONICAL_WIDTH * tolerances["bubbleRadiusMaxRatio"]),
    )
    hough = cv2.HoughCircles(
        smooth,
        cv2.HOUGH_GRADIENT,
        dp=1.1,
        minDist=max(8, round(CANONICAL_WIDTH * 0.015)),
        param1=90,
        param2=16,
        minRadius=minimum_radius,
        maxRadius=maximum_radius,
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
            if dx > max_dx or dy > max_dy:
                continue
            distance = (dx / max_dx) ** 2 + (dy / max_dy) ** 2
            key = (row, lane)
            previous = selected_cells.get(key)
            if previous is None or distance < previous[3]:
                selected_cells[key] = np.asarray(
                    [point[0], point[1], point[2], distance], dtype=np.float64
                )

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
            "temporal-lk-usac",
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
    # choose the phase with the strongest unique ring, row, and edge support.
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
        anchor_error_rows = (
            abs(candidate_start - registered_row_start)
            / max(1.0, shared_y_fit[2])
            if row_anchor_available
            else 0.0
        )
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
            "score": (
                candidate_edge_rows,
                candidate_cell_support,
                candidate_row_support,
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
    best_phase = max(
        phase_hypotheses, key=lambda hypothesis: hypothesis["score"]
    )
    phase_adjustment = int(best_phase["offset"])
    phase_anchor_error_rows = float(
        best_phase.get("anchorErrorRows", 0.0)
    )
    shared_y_fit = best_phase["yFit"]
    expected_rows = (
        shared_y_fit[1]
        + np.arange(25, dtype=np.float32) * shared_y_fit[2]
    )
    blocks = []
    for block_index, block_points in enumerate(block_point_sets):
        row_distance = np.min(
            np.abs(
                block_points[:, 1, None] - expected_rows[None, :]
            ),
            axis=1,
        )
        near_rows = block_points[
            row_distance
            <= max(
                CANONICAL_HEIGHT * 0.0032,
                shared_y_fit[2]
                * tolerances["assignmentYFraction"],
            )
        ]
        refined = _refine_block_lattice(
            near_rows,
            shared_y_fit,
            initial_x_fits[block_index],
            tolerances,
        )
        refined["profileY"] = [
            round(value, 5) for value in shared_y_fit
        ]
        refined["profileX"] = [
            round(value, 5) for value in initial_x_fits[block_index]
        ]
        refined["candidateCount"] = int(len(near_rows))
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
    phase_registration_evidence = (
        sift_bilateral_phase
        or sift_unilateral_phase
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
    phase_anchored = (
        row_anchor_available
        and phase_registration_evidence
        and phase_anchor_error_rows <= 0.30
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
    full_cnn = _cnn_probabilities(patches) if use_cnn else None
    if full_cnn is not None:
        full_cnn = full_cnn.reshape(50, 4)
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
        strong = (
            (relative >= 30.0)
            | adaptive_mark
            | ((relative >= 18.0) & global_mark[row])
        )
        possible = (relative >= 18.0) | adaptive_possible | global_mark[row]
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
                "adaptiveExcess": [
                    round(float(value), 4)
                    for value in normalized_adaptive_excess[row]
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
    # Classify every registered template cell in one batch.  The CNN sees the
    # bubble patch itself, so unlike sheet-relative lane calibration it remains
    # valid for uniform all-A/B/C/D forms.  A weak runner-up is retained as an
    # ambiguity (rather than silently discarded), which protects faint double
    # marks. Borderline top scores retain their likely letter for review but
    # keep the row uncertain, preventing automatic grading.
    decisive_cnn = False
    if use_cnn and full_cnn is not None:
        uncertain_rows = []
        for row in range(50):
            order = np.argsort(full_cnn[row])[::-1]
            selected = int(order[0])
            top_probability = float(full_cnn[row, selected])
            raw_order = np.argsort(means[row])
            raw_selected = int(raw_order[0])
            raw_gap = float(
                means[row, raw_order[1]] - means[row, raw_selected]
            )
            cnn_suppressed_ring_artifacts = {
                index
                for index in range(4)
                if index != selected
                and top_probability >= 0.93
                and float(full_cnn[row, index]) <= 0.04
                and float(dark_fraction[row, selected]) >= 0.62
                and float(means[row, index] - means[row, selected]) >= 58.0
                and float(relative_darkness[row, index]) < 35.0
            }
            cnn_suppressed_ring_artifacts.update({
                index
                for index in range(4)
                if index != selected
                and selected == raw_selected
                and top_probability >= 0.70
                and float(full_cnn[row, index]) <= 0.06
                and float(dark_fraction[row, selected]) >= 0.65
                and raw_gap >= 50.0
                and float(
                    normalized_adaptive_excess[row, index]
                ) < 0.22
            })
            cnn_suppressed_ring_artifacts.update({
                index
                for index in range(4)
                if index != selected
                and selected == raw_selected
                and top_probability >= 0.98
                and float(full_cnn[row, index]) <= 0.078
                and raw_gap >= 90.0
            })
            strong_lanes = [selected] if top_probability >= 0.55 else []
            strong_lanes.extend(
                index
                for index in range(4)
                if index != selected
                and float(full_cnn[row, index]) >= 0.55
                and (
                    float(relative_darkness[row, index]) >= 12.0
                    or float(dark_fraction[row, index]) >= 0.55
                )
            )
            faint_competitors = [
                index
                for index in range(4)
                if index != selected
                and index not in cnn_suppressed_ring_artifacts
                and float(relative_darkness[row, index]) >= 18.0
                and float(normalized_adaptive_excess[row, index]) >= 0.32
                and float(dark_fraction[row, index]) >= 0.20
            ]
            credible_cv_lanes = [
                index
                for index in range(4)
                if index not in cnn_suppressed_ring_artifacts
                if (
                    (
                        float(relative_darkness[row, index]) >= 40.0
                        and float(
                            normalized_adaptive_excess[row, index]
                        ) >= 0.15
                    )
                    or index in faint_competitors
                )
            ]
            contradictory_cv_lanes = [
                index
                for index in credible_cv_lanes
                if index != selected
            ]
            primary_supported = (
                top_probability >= 0.85
                or (
                    top_probability >= 0.55
                    and (
                        float(relative_darkness[row, selected]) >= 40.0
                        or float(dark_fraction[row, selected]) >= 0.40
                    )
                )
                or (
                    selected == raw_selected
                    and top_probability >= 0.25
                    and raw_gap >= 55.0
                    and float(dark_fraction[row, selected]) >= 0.75
                    and max(
                        float(normalized_adaptive_excess[row, index])
                        for index in range(4)
                        if index != selected
                    ) < 0.25
                )
            )
            if len(credible_cv_lanes) >= 2:
                answers[row] = ""
                marked_letters[row] = [
                    CHOICES[index] for index in credible_cv_lanes
                ]
                states[row] = "multiple"
                confidence[row] = min(
                    99.0,
                    max(
                        75.0,
                        min(
                            float(relative_darkness[row, index])
                            for index in credible_cv_lanes
                        ),
                    ),
                )
            elif len(strong_lanes) >= 2:
                answers[row] = ""
                marked_letters[row] = [CHOICES[index] for index in strong_lanes]
                states[row] = "multiple"
                confidence[row] = min(
                    99.0, 100.0 * min(float(full_cnn[row, index]) for index in strong_lanes)
                )
            elif (
                primary_supported
                and not contradictory_cv_lanes
            ):
                answers[row] = CHOICES[selected]
                marked_letters[row] = [CHOICES[selected]]
                states[row] = "single"
                confidence[row] = min(99.0, 100.0 * top_probability)
            elif (
                not credible_cv_lanes
                and (
                    (
                        top_probability <= 0.35
                        and float(dark_fraction[row, selected]) <= 0.40
                        and float(
                            relative_darkness[row, selected]
                        ) < 12.0
                    )
                    or (
                        top_probability <= 0.80
                        and raw_gap <= 35.0
                        and float(np.max(dark_fraction[row])) <= 0.50
                        and float(
                            np.max(
                                normalized_adaptive_excess[row]
                            )
                        )
                        <= 0.28
                    )
                )
            ):
                answers[row] = ""
                marked_letters[row] = []
                states[row] = "blank"
                confidence[row] = min(99.0, 100.0 * (1.0 - top_probability))
            else:
                answers[row] = ""
                uncertain_lanes = {
                    selected,
                    *credible_cv_lanes,
                    *faint_competitors,
                }
                marked_letters[row] = [
                    CHOICES[index] for index in sorted(uncertain_lanes)
                ]
                states[row] = "uncertain"
                confidence[row] = 0.0
                uncertain_rows.append(row)
            diagnostics[row]["cnnMarkedProbability"] = [
                round(float(value), 5) for value in full_cnn[row]
            ]
        ai_checked_rows = 50
        ai_resolved_rows = 50 - len(uncertain_rows)
        decisive_cnn = len(uncertain_rows) == 0
    elif use_cnn and uncertain_rows:
        ambiguous_patches: List[np.ndarray] = []
        for row in uncertain_rows:
            ambiguous_patches.extend(patches[row * 4 : row * 4 + 4])
        probabilities = (
            full_cnn[np.asarray(uncertain_rows, dtype=np.int32)].reshape(-1)
            if full_cnn is not None
            else _cnn_probabilities(ambiguous_patches)
        )
        if probabilities is not None:
            probabilities = probabilities.reshape(len(uncertain_rows), 4)
            ai_checked_rows = len(uncertain_rows)
            still_uncertain: List[int] = []
            for result_index, row in enumerate(uncertain_rows):
                row_probabilities = probabilities[result_index]
                ranked = np.argsort(row_probabilities)[::-1]
                selected = int(ranked[0])
                second = int(ranked[1])
                classical = int(np.argmax(relative_darkness[row]))
                top_gap = float(
                    np.partition(relative_darkness[row], -2)[-1]
                    - np.partition(relative_darkness[row], -2)[-2]
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
        "featureClustering": {
            **clustering,
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
            "mode": "registered-template-batch" if decisive_cnn else "ambiguous-rows-batched",
            "available": _get_cnn_net() is not None if use_cnn and uncertain_rows else MODEL_PATH.exists(),
            "checkedRows": ai_checked_rows,
            "resolvedRows": ai_resolved_rows,
        },
        "rowDiagnostics": diagnostics,
    }


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

    circles, adaptive, locator_details = _find_bubble_candidates(
        warped, geometry_tolerances
    )
    centers, geometry = _fit_answer_grid(
        circles, geometry_tolerances, placement
    )
    return circles, adaptive, locator_details, centers, geometry


def scan_image(image_bytes: bytes, options: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    options = options or {}
    started = time.perf_counter()
    stages: Dict[str, float] = {}
    trace: List[Dict[str, Any]] = []
    placement: Optional[Dict[str, Any]] = None
    gray: Optional[np.ndarray] = None
    current_stage = "decode"
    debug_dir = Path(options["debugDir"]) if options.get("debugDir") else None
    geometry_tolerances = _resolve_geometry_tolerances(options)
    try:
        decode_started = time.perf_counter()
        encoded = np.frombuffer(image_bytes, dtype=np.uint8)
        # Camera captures are normally 4K. Decode them at half resolution for
        # page localization, then warp directly to the canonical grid raster.
        # This removes hundreds of milliseconds without reducing the final
        # bubble patch resolution. Small uploads fall back to full decode.
        gray = cv2.imdecode(encoded, cv2.IMREAD_REDUCED_GRAYSCALE_2)
        decodeScale = 0.5
        if gray is not None and min(gray.shape) < 700:
            gray = cv2.imdecode(encoded, cv2.IMREAD_GRAYSCALE)
            decodeScale = 1.0
        if gray is None or gray.size == 0:
            raise OmrRejected("Image could not be decoded")
        stages["decode"] = _stage_ms(decode_started)
        trace.append({
            "stage": "decode",
            "status": "ok",
            "shape": list(gray.shape),
            "sourceDecodeScale": decodeScale,
        })

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
                    else 48.0
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
        stages["trackingRegistration"] = _stage_ms(tracking_started)

        # A valid temporal update already carries the last accepted canonical
        # transform. Do not rerun page contours or feature matching until its
        # current-frame bubble validation or confidence gate fails.
        if selected is None:
            try:
                contour_candidate = _locate_and_warp(gray)
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

        feature_started: Optional[float] = None
        if selected is None:
            feature_started = time.perf_counter()
            try:
                feature_candidates = _feature_registration_candidates(
                    gray, debug_dir
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
            stages["featureRegistration"] = _stage_ms(feature_started)

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
                    "sift-static-template-usac",
                    "temporal-lk-usac",
                    "otsu-paper-contour",
                    "canny-paper-contour",
                )
                and attempt.get("registrationConfidence") is not None
                and float(attempt["registrationConfidence"])
                >= (
                    52.0
                    if attempt.get("locator")
                    == "temporal-lk-usac"
                    else 48.0
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
        stages["pageAndPerspective"] = _stage_ms(page_started)
        stages["gridLocation"] = round(
            sum(
                float(attempt.get("processingMs", 0.0))
                for attempt in registration_attempts
                if attempt.get("locator")
                == placement.get("locator")
            ),
            3,
        )

        outline = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
        quad = np.asarray(placement.get("corners", []), dtype=np.int32)
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
        _debug_write(debug_dir, "01_document_outline_and_corners", outline)
        _debug_write(debug_dir, "02_warped_sheet", warped)
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
            if placement.get("locator") == "sift-static-template-usac"
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
            if placement.get("locator") == "temporal-lk-usac"
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
            "stage": "fiducial-marker-detection",
            "status": "not-present-on-v1",
            "required": False,
            "reason": (
                "The current v1 form has no dedicated fiducials; fixed print "
                "and the bubble lattice provide registration."
            ),
        })

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
        _update_tracking_cache(gray, options, placement)

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
            "gradeable": classification["uncertainRows"] == 0,
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
            "stageTrace": trace,
            "diagnosticArtifacts": _debug_artifacts(debug_dir),
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
    parser.add_argument("--no-cnn", action="store_true", help="Disable ambiguous-row CNN")
    parser.add_argument(
        "--diagnostics", action="store_true", help="Include per-row feature diagnostics"
    )
    parser.add_argument(
        "--debug-dir",
        help="Write page, warp, bubble-center, recovered-grid, and rejection images",
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
