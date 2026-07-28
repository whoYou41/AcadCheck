#!/usr/bin/env python3
"""Build deterministic, answer-independent registration assets for OMR v1.

The trusted ``real_scans`` set contains the same printed AcadCheck form with
five different answer patterns (all A/B/C/D plus a random sheet).  This tool:

1. calls the production contour locator and adaptive grid fitter;
2. aligns every fitted 200-cell grid into one canonical coordinate system;
3. takes a robust five-image median, so no answer mark can win a pixel vote;
4. restores crisp fixed anchors from the highest-confidence trusted fit and
   replaces every source image's answer-bubble area with the static median;
5. extracts SIFT features only from fixed header, question-number, and footer
   regions (never from answers or user-populated fields); and
6. writes a versioned manifest with images, descriptors, provenance, hashes,
   geometry confidence, and all 200 fitted centers per template.

The generated bundle is consumed at runtime; this script is intentionally kept
separate from ``fast_omr_worker.py`` so asset generation cannot affect grading.
Run from any directory:

    python ml-training/build_registration_templates.py
    python ml-training/build_registration_templates.py --verify-only
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import io
import json
import sys
import zipfile
from pathlib import Path
from typing import Any, Dict, Iterable, List, Sequence, Tuple

import cv2
import numpy as np


SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_SOURCE_DIR = SCRIPT_DIR / "real_scans"
DEFAULT_OUTPUT_DIR = (
    SCRIPT_DIR / "registration_templates" / "acadcheck-50-v1"
)
SOURCE_NAMES = ("allA.jpg", "allB.jpg", "allC.jpg", "allD.jpg", "random.jpg")
GENERATOR_VERSION = 1
DESCRIPTOR_SCHEMA = (
    "x,y,size,angle,response,octave,class_id + 128-float SIFT descriptor"
)


def _load_worker() -> Any:
    worker_path = SCRIPT_DIR / "fast_omr_worker.py"
    spec = importlib.util.spec_from_file_location(
        "acadcheck_fast_omr_worker", worker_path
    )
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot import OMR worker from {worker_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _json_centers(centers: np.ndarray) -> List[List[float]]:
    reshaped = np.asarray(centers, dtype=np.float32).reshape(-1, 2)
    return [
        [round(float(point[0]), 4), round(float(point[1]), 4)]
        for point in reshaped
    ]


def _write_png(path: Path, image: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not cv2.imwrite(
        str(path), image, [cv2.IMWRITE_PNG_COMPRESSION, 9]
    ):
        raise RuntimeError(f"OpenCV could not write {path}")


def _npy_bytes(array: np.ndarray) -> bytes:
    output = io.BytesIO()
    np.save(output, array, allow_pickle=False)
    return output.getvalue()


def _write_reproducible_npz(path: Path, **arrays: np.ndarray) -> None:
    """Write an NPZ with stable member order and timestamps.

    ``numpy.savez_compressed`` embeds the current ZIP timestamp.  Fixed ZIP
    metadata makes repeated builds byte-identical when OpenCV produces the
    same features.
    """

    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(
        path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9
    ) as archive:
        for name in sorted(arrays):
            info = zipfile.ZipInfo(f"{name}.npy", date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o600 << 16
            archive.writestr(info, _npy_bytes(np.asarray(arrays[name])))


def _grid_flat(centers: np.ndarray) -> np.ndarray:
    result = np.asarray(centers, dtype=np.float32).reshape(-1, 2)
    if result.shape != (200, 2):
        raise RuntimeError(
            f"Expected exactly 200 fitted bubble centers, got {result.shape}"
        )
    return result


def _decode_and_fit(
    worker: Any, source_path: Path
) -> Tuple[np.ndarray, np.ndarray, Dict[str, Any], Dict[str, Any]]:
    gray = cv2.imread(str(source_path), cv2.IMREAD_GRAYSCALE)
    if gray is None or gray.size == 0:
        raise RuntimeError(f"Could not decode trusted source {source_path}")
    # Trusted sources are allowed to use their visible contour even when the
    # newly hardened runtime locator flags a frame-edge touch.  This is an
    # offline bootstrap only: the adaptive grid below must still recover all
    # 200 cells before a source can enter the registration bundle.
    try:
        warped, placement = worker._locate_and_warp(
            gray, allow_clipped=True
        )
    except TypeError:
        # Keeps the asset builder compatible with the original v1 locator.
        warped, placement = worker._locate_and_warp(gray)
    circles, _, locator = worker._find_bubble_candidates(
        warped, worker.DEFAULT_GEOMETRY_TOLERANCES
    )
    centers, geometry = worker._fit_answer_grid(
        circles, worker.DEFAULT_GEOMETRY_TOLERANCES
    )
    return warped, _grid_flat(centers), placement, {
        "locator": locator,
        "geometry": geometry,
    }


def _align_to_consensus(
    image: np.ndarray,
    source_centers: np.ndarray,
    consensus_centers: np.ndarray,
    canonical_size: Tuple[int, int],
) -> Tuple[np.ndarray, np.ndarray, float]:
    transform, inlier_mask = cv2.findHomography(
        source_centers,
        consensus_centers,
        method=cv2.LMEDS,
    )
    if transform is None:
        raise RuntimeError("Could not align a trusted fitted grid to consensus")
    projected = cv2.perspectiveTransform(
        source_centers.reshape(-1, 1, 2), transform
    ).reshape(-1, 2)
    residual = np.linalg.norm(projected - consensus_centers, axis=1)
    inliers = (
        inlier_mask.reshape(-1).astype(bool)
        if inlier_mask is not None
        else np.ones(len(residual), dtype=bool)
    )
    if not np.any(inliers):
        raise RuntimeError("Trusted grid alignment produced no inliers")
    median_error = float(np.median(residual[inliers]))
    width, height = canonical_size
    aligned = cv2.warpPerspective(
        image,
        transform,
        (width, height),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=255,
    )
    return aligned, transform, median_error


def _answer_replacement_mask(
    centers: np.ndarray, shape: Tuple[int, int]
) -> Tuple[np.ndarray, int]:
    flat = _grid_flat(centers)
    first_block = flat[:100].reshape(25, 4, 2)
    second_block = flat[100:].reshape(25, 4, 2)
    choice_spacings = np.concatenate(
        (
            np.diff(first_block[:, :, 0], axis=1).reshape(-1),
            np.diff(second_block[:, :, 0], axis=1).reshape(-1),
        )
    )
    spacing = float(np.median(np.abs(choice_spacings)))
    # The printed ring is roughly 0.35 choice-spacing wide.  Replacing a
    # slightly larger disk guarantees that pencil/pen strokes cannot become
    # registration features; the five-sheet median restores the static ring.
    radius = int(round(np.clip(spacing * 0.44, 12.0, 21.0)))
    mask = np.zeros(shape, dtype=np.uint8)
    for x, y in flat:
        cv2.circle(
            mask,
            (int(round(float(x))), int(round(float(y)))),
            radius,
            255,
            thickness=-1,
            lineType=cv2.LINE_8,
        )
    return mask, radius


def _static_feature_mask(
    centers: np.ndarray,
    canonical_width: int,
    canonical_height: int,
    answer_mask: np.ndarray,
) -> Tuple[np.ndarray, Dict[str, Any]]:
    """Select only fixed print that remains useful on partially cropped pages."""

    flat = _grid_flat(centers)
    blocks = (flat[:100].reshape(25, 4, 2), flat[100:].reshape(25, 4, 2))
    row_spacing = float(
        np.median(
            np.concatenate(
                tuple(np.diff(block[:, 0, 1]) for block in blocks)
            )
        )
    )
    mask = np.zeros((canonical_height, canonical_width), dtype=np.uint8)
    regions: List[Dict[str, Any]] = []

    def add_region(name: str, left: float, top: float, right: float, bottom: float) -> None:
        x1 = int(round(np.clip(left, 0, canonical_width - 1)))
        y1 = int(round(np.clip(top, 0, canonical_height - 1)))
        x2 = int(round(np.clip(right, x1 + 1, canonical_width)))
        y2 = int(round(np.clip(bottom, y1 + 1, canonical_height)))
        cv2.rectangle(mask, (x1, y1), (x2 - 1, y2 - 1), 255, thickness=-1)
        regions.append(
            {
                "name": name,
                "pixelRect": [x1, y1, x2, y2],
                "normalizedRect": [
                    round(x1 / canonical_width, 6),
                    round(y1 / canonical_height, 6),
                    round(x2 / canonical_width, 6),
                    round(y2 / canonical_height, 6),
                ],
            }
        )

    # College/semester/ANSWER SHEET headings are fixed.  Name, course, subject,
    # and their writable lines sit below this and deliberately remain masked.
    add_region(
        "fixed-header",
        canonical_width * 0.10,
        canonical_height * 0.012,
        canonical_width * 0.90,
        canonical_height * 0.088,
    )

    # Question numerals are distinctive, survive border crops, and do not
    # contain student data.  Keep strips to the left of each four-choice row.
    for index, block in enumerate(blocks, start=1):
        minimum_x = float(np.min(block[:, :, 0]))
        minimum_y = float(np.min(block[:, :, 1]))
        maximum_y = float(np.max(block[:, :, 1]))
        add_region(
            f"question-number-strip-{index}",
            minimum_x - canonical_width * 0.120,
            minimum_y - row_spacing * 0.60,
            minimum_x - canonical_width * 0.018,
            maximum_y + row_spacing * 0.60,
        )

    # The centered end-of-test legend is fixed.  Sequence/QR/student fields
    # above it are dynamic and are not included.
    add_region(
        "fixed-footer",
        canonical_width * 0.20,
        canonical_height * 0.968,
        canonical_width * 0.80,
        canonical_height * 0.997,
    )

    # Defensive exclusion: even if a future layout expands a selected region,
    # no bubble interior/ring area can enter registration descriptors.
    mask[answer_mask > 0] = 0
    return mask, {
        "regions": regions,
        "rowSpacingPixels": round(row_spacing, 4),
        "selectedPixels": int(np.count_nonzero(mask)),
        "selectedFraction": round(
            float(np.count_nonzero(mask)) / float(mask.size), 6
        ),
    }


def _dynamic_field_mask(
    canonical_width: int, canonical_height: int
) -> Tuple[np.ndarray, List[Dict[str, Any]]]:
    """Mask user/test-specific fields while preserving fixed print anchors."""

    mask = np.zeros((canonical_height, canonical_width), dtype=np.uint8)
    definitions = (
        # Examination subject plus Name and Course/Year writable fields.
        ("header-user-and-exam-fields", 0.08, 0.100, 0.92, 0.195),
        # Sequence, QR, student identity, and other generated footer payloads.
        ("footer-generated-fields", 0.08, 0.875, 0.92, 0.958),
    )
    fields: List[Dict[str, Any]] = []
    for name, left, top, right, bottom in definitions:
        x1 = int(round(left * canonical_width))
        y1 = int(round(top * canonical_height))
        x2 = int(round(right * canonical_width))
        y2 = int(round(bottom * canonical_height))
        cv2.rectangle(
            mask, (x1, y1), (x2 - 1, y2 - 1), 255, thickness=-1
        )
        fields.append(
            {
                "name": name,
                "pixelRect": [x1, y1, x2, y2],
                "normalizedRect": [left, top, right, bottom],
            }
        )
    return mask, fields


def _neutral_background(
    image: np.ndarray, dynamic_mask: np.ndarray
) -> np.ndarray:
    """Replace dynamic fields with smooth row-local paper tone."""

    height, width = image.shape
    horizontal_margin = max(4, round(width * 0.03))
    paper = image[:, horizontal_margin : width - horizontal_margin]
    row_tone = np.percentile(paper, 82, axis=1).astype(np.float32)
    row_tone = cv2.GaussianBlur(
        row_tone.reshape(height, 1), (1, 41), 0
    ).reshape(height)
    background = np.repeat(
        np.clip(np.rint(row_tone), 0, 255).astype(np.uint8)[:, None],
        width,
        axis=1,
    )
    result = image.copy()
    result[dynamic_mask > 0] = background[dynamic_mask > 0]
    return result


def _sift_features(
    image: np.ndarray, feature_mask: np.ndarray
) -> Tuple[np.ndarray, np.ndarray]:
    sift = cv2.SIFT_create(
        nfeatures=2500,
        contrastThreshold=0.012,
        edgeThreshold=16,
    )
    keypoints, descriptors = sift.detectAndCompute(image, feature_mask)
    if not keypoints or descriptors is None:
        raise RuntimeError("Static registration mask produced no SIFT features")
    metadata = np.asarray(
        [
            [
                keypoint.pt[0],
                keypoint.pt[1],
                keypoint.size,
                keypoint.angle,
                keypoint.response,
                float(keypoint.octave),
                float(keypoint.class_id),
            ]
            for keypoint in keypoints
        ],
        dtype=np.float32,
    )
    return metadata, np.asarray(descriptors, dtype=np.float32)


def _template_entry(
    template_id: str,
    role: str,
    image_path: Path,
    descriptor_path: Path,
    output_dir: Path,
    centers: np.ndarray,
    descriptor_count: int,
    extra: Dict[str, Any],
) -> Dict[str, Any]:
    return {
        "id": template_id,
        "role": role,
        "image": image_path.relative_to(output_dir).as_posix(),
        "imageSha256": _sha256(image_path),
        "siftDescriptors": descriptor_path.relative_to(output_dir).as_posix(),
        "siftDescriptorsSha256": _sha256(descriptor_path),
        "descriptorCount": descriptor_count,
        "centerCount": 200,
        "centers": _json_centers(centers),
        **extra,
    }


def build(source_dir: Path, output_dir: Path) -> Dict[str, Any]:
    worker = _load_worker()
    cv2.setNumThreads(1)
    cv2.setRNGSeed(502026)

    canonical_width = int(worker.CANONICAL_WIDTH)
    canonical_height = int(worker.CANONICAL_HEIGHT)
    fitted: List[Dict[str, Any]] = []
    for source_name in SOURCE_NAMES:
        source_path = source_dir / source_name
        if not source_path.is_file():
            raise FileNotFoundError(f"Missing trusted scan: {source_path}")
        warped, centers, placement, diagnostics = _decode_and_fit(
            worker, source_path
        )
        fitted.append(
            {
                "id": source_path.stem,
                "path": source_path,
                "warped": warped,
                "centers": centers,
                "placement": placement,
                "diagnostics": diagnostics,
            }
        )

    # Every source independently recovered the same ordered 50x4 layout.
    # Their coordinate-wise median is robust to one imperfect fitted source.
    consensus_centers = np.median(
        np.stack([entry["centers"] for entry in fitted], axis=0),
        axis=0,
    ).astype(np.float32)
    aligned_images: List[np.ndarray] = []
    for entry in fitted:
        aligned, transform, alignment_error = _align_to_consensus(
            entry["warped"],
            entry["centers"],
            consensus_centers,
            (canonical_width, canonical_height),
        )
        entry["aligned"] = aligned
        entry["alignmentTransform"] = transform
        entry["alignmentError"] = alignment_error
        aligned_images.append(aligned)

    # With all-A/B/C/D plus random, a bubble has at most two marked samples.
    # The median of five therefore selects one of at least three unmarked
    # samples at every answer cell and preserves only static print.
    median_ensemble = np.median(
        np.stack(aligned_images, axis=0), axis=0
    ).astype(np.uint8)
    answer_mask, replacement_radius = _answer_replacement_mask(
        consensus_centers, median_ensemble.shape
    )
    dynamic_mask, dynamic_fields = _dynamic_field_mask(
        canonical_width, canonical_height
    )
    feature_mask, feature_policy = _static_feature_mask(
        consensus_centers,
        canonical_width,
        canonical_height,
        answer_mask,
    )
    anchor = max(
        fitted,
        key=lambda entry: float(
            entry["diagnostics"]["geometry"].get("confidence", 0.0)
        ),
    )
    # Pixelwise medians can ghost thin glyphs after tiny residual local bends.
    # Start with the best-fitted source for crisp fixed print, then replace all
    # answer-dependent areas from the robust five-source median.  Registration
    # descriptors are still limited to the explicit fixed-only mask.
    ensemble = anchor["aligned"].copy()
    ensemble[answer_mask > 0] = median_ensemble[answer_mask > 0]
    ensemble = _neutral_background(ensemble, dynamic_mask)

    image_dir = output_dir / "images"
    descriptor_dir = output_dir / "descriptors"
    image_dir.mkdir(parents=True, exist_ok=True)
    descriptor_dir.mkdir(parents=True, exist_ok=True)
    feature_mask_path = output_dir / "static-feature-mask.png"
    dynamic_mask_path = output_dir / "dynamic-field-mask.png"
    _write_png(feature_mask_path, feature_mask)
    _write_png(dynamic_mask_path, dynamic_mask)

    templates: List[Dict[str, Any]] = []
    for entry in fitted:
        static_image = entry["aligned"].copy()
        static_image[answer_mask > 0] = ensemble[answer_mask > 0]
        static_image[dynamic_mask > 0] = ensemble[dynamic_mask > 0]
        image_path = image_dir / f"{entry['id']}-static.png"
        descriptor_path = descriptor_dir / f"{entry['id']}-static-sift.npz"
        _write_png(image_path, static_image)
        keypoints, descriptors = _sift_features(static_image, feature_mask)
        _write_reproducible_npz(
            descriptor_path,
            keypoints=keypoints,
            descriptors=descriptors,
        )
        source_path = entry["path"]
        templates.append(
            _template_entry(
                entry["id"],
                "trusted-source-static",
                image_path,
                descriptor_path,
                output_dir,
                consensus_centers,
                len(keypoints),
                {
                    "source": (
                        Path("..")
                        / ".."
                        / "real_scans"
                        / source_path.name
                    ).as_posix(),
                    "sourceSha256": _sha256(source_path),
                    "sourceFittedCenters": _json_centers(
                        entry["centers"]
                    ),
                    "alignmentMedianErrorPixels": round(
                        float(entry["alignmentError"]), 6
                    ),
                    "sourceToTemplateHomography": [
                        [round(float(value), 10) for value in row]
                        for row in entry["alignmentTransform"]
                    ],
                    "pageLocator": entry["placement"].get("locator"),
                    "pageConfidence": entry["placement"].get("confidence"),
                    "geometryConfidence": entry["diagnostics"][
                        "geometry"
                    ].get("confidence"),
                },
            )
        )

    ensemble_path = image_dir / "ensemble-static.png"
    ensemble_descriptor_path = descriptor_dir / "ensemble-static-sift.npz"
    _write_png(ensemble_path, ensemble)
    ensemble_keypoints, ensemble_descriptors = _sift_features(
        ensemble, feature_mask
    )
    _write_reproducible_npz(
        ensemble_descriptor_path,
        keypoints=ensemble_keypoints,
        descriptors=ensemble_descriptors,
    )
    templates.insert(
        0,
        _template_entry(
            "ensemble",
            "primary-static-ensemble",
            ensemble_path,
            ensemble_descriptor_path,
            output_dir,
            consensus_centers,
            len(ensemble_keypoints),
            {
                "sources": list(SOURCE_NAMES),
                "aggregation": (
                    "highest-confidence aligned static-print anchor with "
                    "all 200 bubble disks replaced by the five-source median"
                ),
                "fixedAnchorSource": anchor["path"].name,
                "fixedAnchorGeometryConfidence": anchor["diagnostics"][
                    "geometry"
                ].get("confidence"),
                "answerIndependence": (
                    "all-A/all-B/all-C/all-D/random guarantees at least "
                    "three unmarked samples per answer cell"
                ),
            },
        ),
    )

    manifest: Dict[str, Any] = {
        "schemaVersion": 1,
        "assetVersion": "acadcheck-50-v1",
        "generatorVersion": GENERATOR_VERSION,
        "generator": Path(__file__).name,
        "formLayout": str(worker.FORM_LAYOUT),
        "canonicalWidth": canonical_width,
        "canonicalHeight": canonical_height,
        "canonicalSize": [canonical_width, canonical_height],
        "answerRoi": [int(value) for value in worker.ANSWER_ROI],
        "primaryTemplateId": "ensemble",
        "trustedSourceCount": len(fitted),
        "trustedSources": [
            {
                "file": entry["path"].name,
                "sha256": _sha256(entry["path"]),
                "fittedCenterCount": 200,
                "geometryConfidence": entry["diagnostics"][
                    "geometry"
                ].get("confidence"),
            }
            for entry in fitted
        ],
        "answerMasking": {
            "method": (
                "grid-aligned five-source median; source bubble disks "
                "replaced by the median"
            ),
            "replacementRadiusPixels": replacement_radius,
            "replacementCellCount": 200,
            "answersExcludedFromRegistration": True,
        },
        "staticFeatureMask": {
            "image": feature_mask_path.relative_to(output_dir).as_posix(),
            "sha256": _sha256(feature_mask_path),
            "policy": (
                "fixed header + question-number strips + fixed footer; "
                "answer bubbles and user-populated fields excluded"
            ),
            **feature_policy,
        },
        "dynamicFieldMask": {
            "image": dynamic_mask_path.relative_to(output_dir).as_posix(),
            "sha256": _sha256(dynamic_mask_path),
            "fields": dynamic_fields,
            "method": "replace-with-smoothed-row-local-paper-tone",
        },
        "sift": {
            "nfeatures": 2500,
            "contrastThreshold": 0.012,
            "edgeThreshold": 16,
            "descriptorSchema": DESCRIPTOR_SCHEMA,
            "archiveArrays": {
                "keypoints": ["N", 7],
                "descriptors": ["N", 128],
            },
        },
        "templates": templates,
        "validation": {
            "allTrustedSourcesLocated": True,
            "allTrustedSourcesGridFitted": True,
            "fittedCentersPerSource": 200,
            "templateCount": len(templates),
        },
    }
    output_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = output_dir / "manifest.json"
    manifest_path.write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    verify(output_dir)
    return manifest


def _validate_centers(value: Iterable[Sequence[float]], template_id: str) -> None:
    centers = np.asarray(list(value), dtype=np.float32)
    if centers.shape != (200, 2) or not np.all(np.isfinite(centers)):
        raise RuntimeError(
            f"Template {template_id!r} does not contain 200 finite centers"
        )


def verify(output_dir: Path) -> Dict[str, Any]:
    manifest_path = output_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    width = int(manifest["canonicalWidth"])
    height = int(manifest["canonicalHeight"])
    if manifest["canonicalSize"] != [width, height]:
        raise RuntimeError("Manifest canonical size fields disagree")
    if manifest["formLayout"] != "acadcheck-50-v1":
        raise RuntimeError("Unexpected form layout in registration manifest")
    if manifest["trustedSourceCount"] != 5:
        raise RuntimeError("Registration ensemble must contain five sources")

    feature_mask_entry = manifest["staticFeatureMask"]
    feature_mask_path = output_dir / feature_mask_entry["image"]
    if _sha256(feature_mask_path) != feature_mask_entry["sha256"]:
        raise RuntimeError("Static feature mask checksum mismatch")
    feature_mask = cv2.imread(str(feature_mask_path), cv2.IMREAD_GRAYSCALE)
    if feature_mask is None or feature_mask.shape != (height, width):
        raise RuntimeError("Static feature mask dimensions are invalid")
    dynamic_entry = manifest["dynamicFieldMask"]
    dynamic_mask_path = output_dir / dynamic_entry["image"]
    if _sha256(dynamic_mask_path) != dynamic_entry["sha256"]:
        raise RuntimeError("Dynamic field mask checksum mismatch")
    dynamic_mask = cv2.imread(str(dynamic_mask_path), cv2.IMREAD_GRAYSCALE)
    if dynamic_mask is None or dynamic_mask.shape != (height, width):
        raise RuntimeError("Dynamic field mask dimensions are invalid")
    if np.any(
        (feature_mask > 0)
        & (dynamic_mask > 0)
    ):
        raise RuntimeError("A dynamic field entered the static feature mask")

    templates = manifest["templates"]
    if len(templates) != 6:
        raise RuntimeError("Expected one ensemble plus five source templates")
    template_ids = {template["id"] for template in templates}
    if template_ids != {"ensemble", "allA", "allB", "allC", "allD", "random"}:
        raise RuntimeError("Registration bundle has unexpected template IDs")
    primary = next(
        template
        for template in templates
        if template["id"] == manifest["primaryTemplateId"]
    )
    primary_image = cv2.imread(
        str(output_dir / primary["image"]), cv2.IMREAD_GRAYSCALE
    )
    if primary_image is None:
        raise RuntimeError("Primary static ensemble image is unreadable")
    replacement_centers = np.asarray(primary["centers"], dtype=np.float32)
    replacement_mask = np.zeros((height, width), dtype=np.uint8)
    replacement_radius = int(
        manifest["answerMasking"]["replacementRadiusPixels"]
    )
    for x, y in replacement_centers:
        cv2.circle(
            replacement_mask,
            (int(round(float(x))), int(round(float(y)))),
            replacement_radius,
            255,
            thickness=-1,
            lineType=cv2.LINE_8,
        )
    for template in templates:
        template_id = template["id"]
        _validate_centers(template["centers"], template_id)
        if template_id != "ensemble":
            _validate_centers(
                template["sourceFittedCenters"],
                f"{template_id}:sourceFittedCenters",
            )
        image_path = output_dir / template["image"]
        descriptor_path = output_dir / template["siftDescriptors"]
        if _sha256(image_path) != template["imageSha256"]:
            raise RuntimeError(f"Image checksum mismatch for {template_id}")
        if _sha256(descriptor_path) != template["siftDescriptorsSha256"]:
            raise RuntimeError(
                f"Descriptor checksum mismatch for {template_id}"
            )
        image = cv2.imread(str(image_path), cv2.IMREAD_GRAYSCALE)
        if image is None or image.shape != (height, width):
            raise RuntimeError(f"Invalid image dimensions for {template_id}")
        if template_id != "ensemble" and not np.array_equal(
            image[replacement_mask > 0],
            primary_image[replacement_mask > 0],
        ):
            raise RuntimeError(
                f"Answer areas were not neutralized in {template_id}"
            )
        if template_id != "ensemble" and not np.array_equal(
            image[dynamic_mask > 0],
            primary_image[dynamic_mask > 0],
        ):
            raise RuntimeError(
                f"Dynamic user fields were not neutralized in {template_id}"
            )
        with np.load(descriptor_path, allow_pickle=False) as archive:
            keypoints = archive["keypoints"]
            descriptors = archive["descriptors"]
        if keypoints.ndim != 2 or keypoints.shape[1] != 7:
            raise RuntimeError(f"Invalid keypoint array for {template_id}")
        if descriptors.shape != (len(keypoints), 128):
            raise RuntimeError(f"Invalid SIFT descriptors for {template_id}")
        if keypoints.dtype != np.float32 or descriptors.dtype != np.float32:
            raise RuntimeError(
                f"Unexpected descriptor data type for {template_id}"
            )
        if not np.all(np.isfinite(keypoints)) or not np.all(
            np.isfinite(descriptors)
        ):
            raise RuntimeError(
                f"Non-finite registration features for {template_id}"
            )
        if len(keypoints) != template["descriptorCount"]:
            raise RuntimeError(
                f"Descriptor count mismatch for {template_id}"
            )
        keypoint_x = np.clip(
            np.rint(keypoints[:, 0]).astype(np.int32), 0, width - 1
        )
        keypoint_y = np.clip(
            np.rint(keypoints[:, 1]).astype(np.int32), 0, height - 1
        )
        if np.any(feature_mask[keypoint_y, keypoint_x] == 0):
            raise RuntimeError(
                f"SIFT keypoint escaped the static mask for {template_id}"
            )
        if np.any(replacement_mask[keypoint_y, keypoint_x] > 0):
            raise RuntimeError(
                f"SIFT keypoint overlaps an answer area for {template_id}"
            )
        for x, y in template["centers"]:
            xi = int(round(float(x)))
            yi = int(round(float(y)))
            if 0 <= xi < width and 0 <= yi < height:
                if feature_mask[yi, xi] != 0:
                    raise RuntimeError(
                        f"Answer center entered feature mask for {template_id}"
                    )
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Build masked AcadCheck OMR registration templates"
    )
    parser.add_argument(
        "--source-dir", type=Path, default=DEFAULT_SOURCE_DIR
    )
    parser.add_argument(
        "--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR
    )
    parser.add_argument(
        "--verify-only",
        action="store_true",
        help="validate the existing manifest, images, and descriptors",
    )
    arguments = parser.parse_args()
    source_dir = arguments.source_dir.resolve()
    output_dir = arguments.output_dir.resolve()
    manifest = (
        verify(output_dir)
        if arguments.verify_only
        else build(source_dir, output_dir)
    )
    summary = {
        "status": "verified" if arguments.verify_only else "built-and-verified",
        "manifest": str(output_dir / "manifest.json"),
        "formLayout": manifest["formLayout"],
        "canonicalSize": manifest["canonicalSize"],
        "trustedSources": manifest["trustedSourceCount"],
        "templates": len(manifest["templates"]),
        "descriptors": {
            template["id"]: template["descriptorCount"]
            for template in manifest["templates"]
        },
        "answersExcludedFromRegistration": manifest["answerMasking"][
            "answersExcludedFromRegistration"
        ],
    }
    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
