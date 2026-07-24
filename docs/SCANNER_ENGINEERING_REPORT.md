# AcadCheck Scanner Engineering Report

Date: 2026-07-25

## Outcome

AcadCheck's generated 50-question, four-choice answer sheet now uses a
fail-closed hybrid scanner:

`camera frame -> one decode -> page/perspective correction -> answer ROI ->
verified 50-row lattice -> rule-based mark classification -> batched CNN only
for uncertain rows -> accept or reject`

On the current benchmark, the scanner read all 45 normal-condition sheets
correctly. The production OMR worker averaged 179.696 ms, while concurrent QR
identity plus OMR averaged 429.184 ms warm and 867.312 ms cold. This is an
observed result on the available data, not a claim that all future cameras,
printers, pens, or environments are guaranteed to achieve 100%.

The generated-form regression was repeated after adding the QR-adjacent
handwritten sequence field. Twelve blank/marked cases covered dim exposure,
plus/minus 3-degree rotation, perspective distortion, multiple marks, and
three synthetic mark intensities. All expected blank, single, and multiple
states passed. OMR averaged 221.877 ms and the slowest case took 343.997 ms.
The persistent QR/sequence worker took 621.2 ms including first startup and
143.3-238.5 ms on four warm variants. These generated-image checks complement,
but do not replace, a larger independent physical-sheet validation set.

## Test hardware and software

- CPU: Intel Core i5-9300H, 4 cores / 8 logical processors, 2.40 GHz
- Node.js: 24.13.1
- Python: 3.14.6
- OpenCV: 5.0.0, configured for 8 threads
- Operating system: Windows

No Raspberry Pi target specification or physical Pi was available for this
measurement. Pi performance must therefore be measured on the deployment
device before making a sub-second guarantee for that device.

## Before and after

The baseline used the integrated scanner that existed before this redesign and
four labeled physical captures (`allA`, `allB`, `allC`, and `allD`). The new
regression benchmark adds a fifth physical random-answer capture and nine
normal-condition variants per capture. These development images are not an
independent holdout set.

| Metric | Before | After |
| --- | ---: | ---: |
| Labeled physical captures | 4 | 5 |
| Normal-condition test sheets | 4 | 45 |
| Questions evaluated | 200 | 2,250 |
| Bubble positions evaluated | 800 | 9,000 |
| Question accuracy | 0.00% | 100.00% |
| Exact-sheet accuracy | 0.00% | 100.00% |
| Precision | 0.00% | 100.00% |
| Recall | 0.00% | 100.00% |
| False-positive rate | 16.67% | 0.00% |
| False-negative rate | 100.00% | 0.00% |
| Integrated/module wall time | 10,717 ms | 429.184 ms warm QR + OMR |
| Cold QR + OMR wall time | Not instrumented | 867.312 ms |
| Warm QR + OMR p95 wall time | Not instrumented | 457.226 ms |
| Scanner-core processing time | Not separately instrumented | 165.219 ms |
| Warm OMR worker wall time | Not instrumented | 179.696 ms |
| OMR worker p95 wall time | Not instrumented | 192.843 ms |
| OMR worker sampled peak RSS | Not instrumented | 77.680 MiB |
| Worker RSS after normal scans | Not instrumented | 45.035 MiB |
| Worker RSS after CNN use | Not instrumented | 48.598 MiB |
| QR worker sampled RSS | Not instrumented | 13.309 MiB |

The current normal, one-mark benchmark confusion matrix is:

- True positives: 2,250
- True negatives: 6,750
- False positives: 0
- False negatives: 0

The benchmark harness consumed 17.844 CPU seconds during 11.396 wall seconds,
or 156.58% of one CPU core (about 1.57 core equivalents). Its 136.527 MiB peak
RSS includes all source and transformed test images held by the benchmark; the
separate production-worker memory figures above are representative of the
deployed scanner process. Worker peak RSS is sampled every 5 ms, so very short
transient peaks may be missed.

The worker wall time includes Python request framing and the returned scanner
response. It does not include browser JPEG creation, network latency, endpoint
authentication, or later database grading writes. The core timing stops before
fingerprint/response serialization, so worker wall time is the more useful
deployment scanner figure. The old integrated timing and new concurrent
final-detector timing are the closest available comparison, but they are not a
full camera-to-record end-to-end measurement.

The final-capture integration fixture runs the persistent QR and OMR workers
concurrently on a labeled physical capture with a generated V1 QR in the
reserved bottom region. All cold, warm, dark, and blurred checks decoded the
exact QR and all 50 bubbles. It excludes endpoint authentication, database
writes, and optional student OCR. The QR worker used 0.109 CPU seconds across
four direct test calls and had a 13.309 MiB sampled peak RSS.

Baseline CPU and memory were not captured before the old implementation was
replaced, so no invented comparison is reported for those two fields.

## Validation set

The repeatable benchmark uses five labeled physical source sheets, apparently
from the same camera/capture setup:

- 50 A answers
- 50 B answers
- 50 C answers
- 50 D answers
- one mixed, random-answer sheet

Each is tested as:

- original capture
- rotation of -3 degrees
- rotation of +3 degrees
- 28% darker exposure
- 10% brighter exposure
- directional lighting gradient
- slight perspective distortion
- reduced apparent distance/scale (0.78)
- 5 x 5 blur

All 45 regression sheets were gradeable, all 2,250 answers were correct, and
all 9,000 bubble states were correct. Additional state tests verified:

- four explicit blank rows, retained as blank and scored zero
- three explicit multiple-mark rows, retained as multiple and scored zero
- a deliberately faint second mark, preserved as ambiguous and rejected
- moderately faint single marks, read correctly
- one borderline faint mark, rejected as uncertain rather than guessed

Precision, recall, false-positive rate, and false-negative rate are computed
only on the 45 normal one-mark cases. Blank/multiple/uncertain behavior is
covered by the five explicit scenario checks, not by a large confusion matrix.

The scanner therefore meets the requested 99% target on the available
normal-condition regression benchmark and stays far below one second on the
measured computer. This is not yet an independent estimate of field accuracy.
A production-level statistical guarantee still requires a larger, sequestered
set covering the actual phones/Pi cameras, printers, paper, pens, desks, and
rooms used by the school.

## Sources of recognition errors found

| Previous problem | Effect | Resolution |
| --- | --- | --- |
| Perspective correction was bypassed or duplicated | Shifted rows and lanes; wasted work | Locate the page at low resolution and perform one validated perspective warp |
| Full camera frame was repeatedly analyzed | Desk/background became bubble candidates | Crop once to the canonical answer ROI |
| Fixed absolute darkness thresholds | Bright or dark frames changed answers | Use local paper-normalized and row-relative features |
| Question-number circles could become answer lanes | Confident A/B/C/D lane shifts | Radius filtering plus independently verified left/right lattices |
| Weak or partial geometry was assigned high confidence | Incorrect sheets could be accepted | Keep geometry confidence separate and reject incomplete/unstable grids |
| One global row fit could move the second block | Off-by-one answers near questions 26-50 | Fit both 25-row blocks and cross-anchor their row phase |
| No safe ambiguous state | Faint or close marks were guessed | Explicit blank, single, multiple, and uncertain states |
| CNN was treated as a universal answer | Domain mismatch and unnecessary inference cost | Rule-based primary path; one batched CNN call only for uncertain rows |
| Pi proportional-grid/OCR output could grade a sheet | Weak geometry could become authoritative | Pi remains a camera source only; its direct grading fallback was removed |
| Answer-key layouts allowed 25/100 questions and A-E | Scanner/template contract was inconsistent | Generated and saved keys are now exactly 50 questions, choices A-D |
| Date/sequence fallback could override key identity | A scan could use the wrong key | The versioned QR on the final captured page is authoritative |
| Repeated answer strings were treated as duplicate sheets | The same page could rescan, or two students with identical answers could be confused | Require two confirmed no-page frames before rearming; fingerprints remain diagnostic |
| Auto-detected student stayed selected | Later sheets could be assigned to the previous student | Clear only auto-selected IDs after success; preserve deliberate manual locks |

## Performance bottlenecks found

| Previous bottleneck | Change |
| --- | --- |
| A new Python/OpenCV process for every frame | One persistent binary-framed worker |
| Repeated image decode and Sharp re-encode | Send the original encoded bytes and decode once |
| Client JavaScript loop over every pixel | Native canvas grayscale and resize |
| Page rectification in both Node and Python | Canonical forms are rectified only in the worker |
| Repeated connected components, thresholding, and Hough work | One answer ROI, one adaptive mask, reused intermediates |
| CNN invocation per bubble/row | One dynamic batch, and only when rules are uncertain |
| Model initialization on every request | Lazy-load once and cache in the persistent worker |
| A fresh Python process for every QR | A second persistent binary-framed worker with canonical bottom-ROI recovery |
| QR and OMR ran serially | Start final QR identity and fixed-form OMR concurrently |
| Serial OCR and OMR | Start independent work concurrently where it is needed |
| QR/rectification before a selected-key database lookup | Resolve `answerKeyId` first |
| 50 individual scan-result inserts | One multi-row database insert |
| 2-second live polling, three stable frames, 20-second cooldown | 450 ms polling, one verified fast frame, 1.5-second sheet-change cooldown |

## New scanner design

### Page detection and preprocessing

1. Decode the encoded camera image directly to grayscale.
2. Downscale only for fast page localization.
3. Find the bright paper using Otsu thresholding and morphological closing,
   with an edge-based fallback.
4. Validate the quadrilateral's area, aspect, convexity, and edge placement.
5. Perspective-warp once to an 800 x 1,400 canonical image.
6. Work only inside the answer ROI.
7. Apply CLAHE only when the ROI's measured tonal range is too narrow.
8. Build one adaptive-threshold mask and clean it with morphology.

### Grid and bubble detection

- Hough circles provide the primary ring candidates.
- Area, aspect ratio, circularity, and radius filtering remove text, digits,
  and noise.
- Robust contour candidates supplement Hough only when support is insufficient.
- The two 25-question blocks are fitted separately.
- Row spacing, lane spacing, cell support, cross-block row phase, and residual
  error must all pass before marks can be trusted.
- Small question-number circles cannot define the A-D lanes.

### Mark classification and confidence

Each cell measures inner intensity, nearby paper intensity, adaptive fill, and
dark-pixel fraction. Decisions use within-row differences and a sheet-level
two-cluster threshold, making them substantially less sensitive to exposure.

Each question is represented as one of:

- `blank`
- `single`
- `multiple`
- `uncertain`

Blank and multiple rows are valid, explicit student responses and score zero.
An uncertain row rejects the entire grade. The scanner does not silently turn
low confidence into a guessed answer.

Geometry confidence and mark confidence are separate. A high-contrast mark
cannot compensate for missing page/grid evidence.

### Why the CNN is retained only as a fallback

The available ONNX bubble model is fast when run as one dynamic batch, but its
training/validation history contains domain-overlap risk and it is not safe
enough to establish form geometry. Using it for every bubble also adds work to
the common, easy case.

The implemented hybrid is faster and safer:

- OpenCV establishes the page, row, lane, and cell geometry.
- Relative image features resolve normal blank/single/multiple marks.
- Only genuinely uncertain rows are submitted to the CNN in one batch.
- The CNN must meet strict probability and consensus checks.
- If it cannot resolve a row safely, the sheet remains rejected.

Only four of the 2,250 normal rows required CNN review; each was a weak printed
ring artifact under blur, perspective, rotation, or bright exposure, and was
resolved only after independent image-feature gates agreed. The explicit
ambiguous tests confirmed that unresolved faint marks fail closed. The model
was developed from the available scan assets, so this fallback check is an
integration test, not an independent measurement of CNN generalization.

## Camera behavior

The fast form reader can detect a newly entered answer sheet anywhere in the
camera frame when the complete page is visible at usable resolution. The page
does not need to be manually aligned to a fixed overlay; perspective correction
normalizes its position and slight rotation.

The full border and answer area still need to be visible. A cropped, extremely
distant, motion-blurred, folded, or heavily shadowed sheet is rejected and the
UI asks for another frame. This is intentional: accepting a partial sheet would
conflict with the accuracy requirement.

Once a verified fast-grid result arrives, the UI can accept it from one frame.
After a successful auto-grade, the scanner requires two consecutive,
explicitly detected no-page frames before it rearms. This is more reliable than
comparing answers or header hashes, both of which can legitimately match
between students or move under rotation. The UI continues observing removal
during its short result cooldown, so a normal sheet swap does not add another
long delay. The header fingerprint remains available as supplemental
diagnostic data.

## Generated-sheet compatibility and QR identity

- Answer keys are constrained to 50 A-D answers, matching the supplied Word
  template and scanner lattice.
- New generated QR payloads use the compact versioned form
  `AC1:<answer-key-id>:<base64url-token>` so the small printed code remains
  easy for OpenCV to decode. Existing V1 and legacy QR payloads remain readable.
- QR resolution checks the owner, active status, question count, and layout.
- A selected key accelerates live preview, but the QR is decoded again once
  from the final captured page and becomes the grading key. A mismatched
  previous selection is replaced; a missing/invalid QR rejects the grade.
- The supplied template is stored at `backend/templates/Answer-Sheet.docx` and
  used without changing its page geometry.
- The classroom name replaces the subject placeholder.
- The QR image fills each reserved bottom cube immediately before the
  `---End of the Multiple Test---` marker. Four bordered
  `STUDENT SEQUENCE NO.` boxes sit directly to its right.
- The QR selects the answer key and classroom. A handwritten 1-4 digit number
  selects only the matching student sequence inside that classroom; leading
  zeroes are ignored.
- The digit classifier is a standalone 10-class ONNX model (the obsolete
  50-class model and external sidecar were removed). Its held-out MNIST
  accuracy was 99.120%, and QR-adjacent digit-box inference is used only for
  student identity, not bubble grading.
- The fast OMR canonical page now matches the template's tall half-page aspect.
  Per-lane printed-letter calibration prevents the darker printed B/D glyphs
  from becoming false marks, while normalized adaptive-fill evidence retains
  faint pencil marks.
- A user can print immediately or leave the generated sheet pending and print
  later.

An in-memory generation check confirmed that both subject placeholders were
updated and the inserted QR decoded back to the exact versioned payload. The
detector also recovered the exact payload from full-page, dark, and 5 x 5
blur-equivalent integration fixtures.

## Maintainability and failure behavior

- The Node wrapper owns worker startup, request IDs, framing, timeouts,
  automatic restart, and shutdown.
- Scanner details include per-stage timing, placement, grid support, rejected
  row numbers, confidence, CNN activity, and sheet fingerprint.
- The production source is explicitly named `fast-hybrid-grid`; rejected
  results are never put into a trusted source.
- Database scan status uses schema-compatible values.
- The browser, server, generated form, and QR all share the same 50 x A-D
  contract.
- Old weaker results cannot become grade-authoritative for the generated form.

## Tuning conclusion and known limits

Profiling showed that grid localization is the largest core stage. During
tuning, more aggressive downscaling, looser geometry gates, and accepting
unresolved rows reintroduced row/lane errors for only marginal latency
reduction. The retained 800 x 1,400 canonical size and answer ROI are the
fastest configuration found that preserved every current regression and state
check. This was an engineering tuning exercise rather than a formal parameter
ablation or statistical-significance study.

Known limits:

- The measured data set is small, derived from five development captures, and
  is not a sequestered holdout.
- Synthetic lighting/rotation tests do not replace independent field samples.
- The Pi hardware was unavailable for direct timing and thermal testing.
- Severe glare, page cropping, or perspective beyond normal hand-held use may
  be rejected.
- Noncanonical legacy sheets are retained only for compatibility and are not
  covered by these accuracy numbers.

## Reproducing the checks

From `C:\AcadCheck`:

```powershell
python ml-training\benchmark_fast_omr.py
node ml-training\benchmark_qr_omr_pipeline.js
python -m py_compile ml-training\fast_omr_worker.py ml-training\benchmark_fast_omr.py ml-training\detect_qr.py raspberry-pi-camera\camera-server.py
node --check backend\server.js
node --check backend\enhanced-scanner.js
node --check backend\adaptive-form-omr.js
node --check backend\qr-code-detector.js
npx tsc --noEmit
npx ngc --noEmit
```

The OMR benchmark exits nonzero if normal-condition question or exact-sheet
accuracy drops below 99%, a normal sheet or warm worker average reaches one
second, the worker misses an original sheet, or a
blank/multiple/faint-double/uncertain state case behaves incorrectly. The
combined benchmark exits nonzero if QR/OMR is incorrect or any tested detector
run reaches one second.
