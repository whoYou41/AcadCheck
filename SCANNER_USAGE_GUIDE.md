# Enhanced Scanner - Practical Guide

## Quick Start

The scanner is now **automatically smarter**. No configuration needed. Just upload scans as usual, and the system will:

1. ✅ Detect fainter/lighter bubble marks
2. ✅ Extract student names and numbers more accurately
3. ✅ Provide confidence scores for each detected answer
4. ✅ Handle various writing/marking styles (checkmarks, light fills, hatching, etc.)

## Understanding Confidence Scores

When you view scan results, you'll now see confidence scores per question:

```
Question 1: Answer = B  [Confidence: 95%] ✓ Excellent
Question 2: Answer = A  [Confidence: 78%] ⚠ Review recommended
Question 3: Answer = -  [Confidence: 0%]  ✗ Not detected
```

### What the scores mean:

| Score | Meaning | Action |
|-------|---------|--------|
| 90-99% | Crystal clear mark | Auto-grade is safe |
| 80-89% | Clear but slight uncertainty | Review optional |
| 70-79% | Faint mark or small doubt | Manual review recommended |
| 60-69% | Very faint/ambiguous | Manual review required |
| <60% | Unreliable | Manual entry needed |
| 0% | No mark detected | Blank or invalid |

## Student Information Extraction

The system now better extracts:

### Student Number
Recognizes formats:
- ✓ S1234-567 (with prefix)
- ✓ 1234-567 (without prefix)
- ✓ 1234567 (no dash)
- ✓ Various labels: "Student ID:", "No.", "ID:", etc.

### Student Name
Recognizes:
- ✓ "Name: John Michael Smith"
- ✓ "Student: Jane Doe"
- ✓ Hyphenated names: "Jean-Pierre"
- ✓ Middle names automatically handled
- ✓ Suffixes: "Jr.", "Sr.", etc.

### How it shows up:
```
Student Found:
  Number: S1234-567 (Confidence: 95%)
  Name: John Michael Smith (Confidence: 88%)
```

## Improving Scan Quality

### Tips for better detection:

1. **Lighting**
   - Use even, diffused lighting
   - Avoid shadows across bubbles
   - Don't scan against bright windows

2. **Bubble Marking**
   - Encourage students to:
     - Fill bubbles completely ●
     - Not just make a single dot ·
     - Use dark pen/pencil
     - Avoid light gray lead

3. **Name/ID Field**
   - Ensure text is clear and readable
   - Dark pen on light paper
   - Standard formats are easier to read

4. **Document Condition**
   - Scan clean, unwrinkled papers
   - No folds, tears, or water damage
   - Good resolution (200+ DPI recommended)

### What happens if quality is poor:

**Low confidence bubble (< 70%):**
→ Question marked for manual review
→ Shows up in review queue with warning icon
→ You can click "View Scan Image" to see the actual mark

**Name/Number not found (confidence < 60%):**
→ Shows in "Unmatched Scans" section
→ Option to manually enter or search database
→ Auto-match if similar name found (fuzzy matching)

## Working with Detection Results

### Viewing Scan Analysis

When you open a scan, you now see:

```
SCAN ANALYSIS
─────────────────────────────────
OCR Quality: 95%
  ✓ Student Number: S1234-567
  ✓ Student Name: John Smith
  
Bubble Detection: 91%
  ✓ 45 answers detected
  ⚠ 2 questions flagged for review
  ✗ 3 questions left blank
  
Grading: 45/50 (90%)
  ✓ Correct: 45
  ✗ Incorrect: 5
  
OVERALL QUALITY: 91% (High)
Recommendation: Auto-grade safe
```

### Reviewing Flagged Questions

Click on any flagged question to:
1. See the actual scan image of that area
2. View why it was flagged (lighting, partial mark, etc.)
3. Manually override the detected answer if needed
4. Leave as-is if the system's answer is correct

## Handling Edge Cases

### Multiple marks in one question
The system detects the **darkest mark** as the answer:
```
Question 5: 
  ●    (Confidence: 85%) <- Darkest
  ◐    (Lighter)
  ○
  ○
→ Detected: A (the darkest mark)
→ Shows warning: "Multiple marks detected"
```

### Partially filled bubbles
The system analyzes shading **percentage**, so:
- 100% filled bubble (dark): High confidence
- 80% filled bubble: Good confidence
- 50% filled bubble: Medium confidence
- 20% filled bubble: Low confidence
- Light scratch: Alerts for review

### Faded or light pencil marks
The enhanced algorithm now catches these by analyzing:
1. Overall darkness of the region
2. Percentage of dark pixels (not just average)
3. Comparison with surrounding bubbles

→ May have lower confidence (60-75%)
→ Recommended for manual review
→ But no longer completely missed

### Checkmarks or X marks
The system treats any dark mark in a bubble region as an answer:
- ✓ (checkmark): Detected as filled
- ✗ (X mark): Detected as filled
- ◎ (circled): Detected as filled

→ Confidence depends on how dark the mark is

## API/Integration

### For developers integrating with the API:

#### Enhanced Response Structure

```javascript
// GET /api/scans/:id
{
  "scan": {
    "id": 123,
    "student_number_detected": "S1234-567",
    "student_name_detected": "John Smith",
    "ocr_confidence": 95,
    "omrResults": [
      {
        "question_number": 1,
        "detected_answer": "B",
        "correct_answer": "B",
        "is_correct": true,
        "confidence": 95  // NEW: Per-question confidence
      },
      {
        "question_number": 2,
        "detected_answer": "A",
        "correct_answer": "A",
        "is_correct": true,
        "confidence": 78  // NEW: Faint mark detected
      },
      {
        "question_number": 3,
        "detected_answer": "",
        "correct_answer": "C",
        "is_correct": false,
        "confidence": 0   // NEW: Nothing detected
      }
    ],
    "ocrExtractions": [
      {
        "field_name": "student_number",
        "extracted_value": "S1234-567",
        "confidence": 95
      },
      {
        "field_name": "student_name",
        "extracted_value": "John Smith",
        "confidence": 88
      }
    ],
    "scanQualityMetrics": {
      "ocrQuality": 95,
      "bubbleDetectionQuality": 91,
      "overallQuality": 91
    }
  }
}
```

### Filtering by Quality

```javascript
// Get only high-quality scans (safe for auto-grade)
const highQuality = scans.filter(s => s.scanQualityMetrics.overallQuality >= 85);

// Get scans needing review
const needsReview = scans.filter(s => 
  s.scanQualityMetrics.overallQuality < 85 && 
  s.scanQualityMetrics.overallQuality >= 75
);

// Get scans with problems
const problematic = scans.filter(s => s.scanQualityMetrics.overallQuality < 75);
```

## Troubleshooting

### Q: Why is a clear mark showing low confidence?

**A:** Possible causes:
- The bubble region detection might be off (try adjusting scan position)
- Mark is very light (confidence will be 60-75%)
- Multiple marks in same question (system picks darkest)

**Solution:** Check the scan image, verify lighting, retry with clearer mark

### Q: Why isn't the student name being found?

**A:** Possible causes:
- OCR quality too low (confidence < 60%)
- Name not in typical format
- Poor image quality

**Solutions:**
- Check OCR confidence score
- Manually enter name when needed
- Improve image quality for next scans

### Q: Can I trust confidence scores?

**A:** Yes! Scores are calculated based on:
1. How dark the mark is
2. What percentage of the bubble is dark
3. How it compares to other marks
4. Mark style consistency

**Trust level:**
- 90%+ confidence: Very trustworthy
- 75-89%: Reasonably trustworthy
- < 75%: Manual review recommended

### Q: What if the system keeps missing marks?

**A:** This usually means:
1. Marks are very faint → request darker pens
2. Bad scan quality → improve lighting/camera
3. Scan is rotated → ensure proper alignment
4. Bubble is outside expected region → check form alignment

Contact support with sample scans if issue persists.

## Performance Impact

The enhanced scanner processes scans slightly slower but more accurately:

**Before:** ~2-3 seconds per scan (less accurate)
**After:** ~3-6 seconds per scan (more accurate)

This is acceptable because:
- Background processing (doesn't block UI)
- You get better detection and confidence scores
- Worth the small time investment

## Best Practices

1. **Always review scans with confidence < 75%**
   - Takes 5-10 seconds per question
   - Catches potential errors

2. **Monitor quality trends**
   - Low average confidence? Check scan equipment
   - Some students scoring suspiciously well? Verify with confidence scores

3. **Use auto-grade only for high-confidence scans**
   - Set policy: Auto-grade if overall quality ≥ 85%
   - Otherwise: Review or manual entry

4. **Keep sample scans for training**
   - Show students examples of good vs. poor marks
   - Results in cleaner scans over time

5. **Provide feedback to students**
   - "Your mark was detected with 92% confidence"
   - "Please mark more clearly next time"

---

## Support & Feedback

If you encounter:
- Consistently low confidence on good marks
- False detections (marks where none exist)
- Student info extraction failures
- Other issues

Please provide:
1. Sample scan image
2. Expected answer key
3. Expected student info
4. Confidence scores reported

This helps us continue improving the scanner!
