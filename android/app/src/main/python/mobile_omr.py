"""Thin Android bridge around AcadCheck's proven OpenCV OMR worker."""

import base64
import json
import os
from pathlib import Path

_ROOT = Path(__file__).resolve().parent
os.environ.setdefault(
    "OMR_REGISTRATION_TEMPLATE_DIR",
    str(_ROOT / "registration_templates" / "acadcheck-50-v1"),
)
os.environ.setdefault(
    "OMR_BUBBLE_MODEL_PATH",
    str(_ROOT / "models" / "bubble-classifier.onnx"),
)
os.environ.setdefault("OMR_OPENCV_THREADS", "2")

os.environ.setdefault(
    'OMR_DIGIT_MODEL_PATH',
    str(_ROOT / 'models' / 'digit-classifier.onnx'),
)

import fast_omr_worker
import cv2


def prewarm():
    templates = fast_omr_worker._load_registration_templates()
    if (
        not templates
        or fast_omr_worker._get_cnn_net() is None
        or fast_omr_worker._get_digit_net() is None
    ):
        raise RuntimeError("The bundled answer-sheet templates or bubble verifier could not be loaded")
    return json.dumps(
        {
            "ready": bool(templates),
            "engine": "acadcheck-native-opencv-v1",
            "opencvVersion": cv2.__version__,
            "templateCount": len(templates),
        },
        separators=(",", ":"),
    )


def scan_base64(image_base64, question_count=50, tracking_session_id="", frame_id=""):
    try:
        image_bytes = base64.b64decode(image_base64, validate=True)
    except (TypeError, ValueError) as error:
        return json.dumps({"success": False, "reason": str(error)})
    options = {
        "useCnn": True,
        "includeDiagnostics": False,
        "includeOverlayGeometry": True,
        "detectSequence": True,
    }
    if tracking_session_id:
        options["trackingSessionId"] = str(tracking_session_id)
        options["frameId"] = int(frame_id)
    result = fast_omr_worker.scan_image(image_bytes, options)
    # Keep the native/WebView bridge small; feature arrays and debug images
    # are not needed to display or save the accepted scan.
    fields = (
        "success", "gradeable", "geometryVerified", "answers", "confidenceScores",
        "markedLetters", "rowStates", "averageConfidence", "qualityMetrics",
        "sheetPresence", "presenceConfidence", "sheetFingerprint",
        "sheetFingerprintVersion", "overlayGeometry", "processingMs", "reason",
        "uncertainRows", "blankRows", "multipleRows", "stagesMs", "timingDetails",
    )
    response = {key: result[key] for key in fields if key in result}
    sequence_details = result.get('qualityMetrics') or {}
    for key in (
        'sequence', 'sequenceCandidate', 'sequenceConfidence', 'sequenceRawDigits',
        'sequenceBoxCount', 'sequenceDigitConfidences',
    ):
        if key in sequence_details:
            response[key] = sequence_details[key]
    response["nativeEngine"] = "acadcheck-native-opencv-v1"
    response["questionCount"] = max(1, min(50, int(question_count)))
    return json.dumps(response, separators=(",", ":"))
