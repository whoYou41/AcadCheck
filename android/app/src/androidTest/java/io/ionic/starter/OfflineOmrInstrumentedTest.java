package io.ionic.starter;

import static org.junit.Assert.*;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Matrix;
import android.util.Base64;
import android.util.Log;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.chaquo.python.PyObject;
import com.chaquo.python.Python;
import com.chaquo.python.android.AndroidPlatform;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Exercises the actual packaged Python, OpenCV, model and template assets. */
@RunWith(AndroidJUnit4.class)
public class OfflineOmrInstrumentedTest {
    private PyObject worker() throws Exception {
        // Production initializes Python on the OMR executor, leaving the first
        // activity and camera connection free to render immediately.
        if (!Python.isStarted()) Python.start(new AndroidPlatform(
            InstrumentationRegistry.getInstrumentation().getTargetContext()));
        PyObject worker = Python.getInstance().getModule("mobile_omr");
        JSONObject ready = new JSONObject(worker.callAttr("prewarm").toString());
        assertTrue(ready.toString(), ready.getBoolean("ready"));
        assertEquals(6, ready.getInt("templateCount"));
        return worker;
    }

    private String fixture(String name) throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getContext();
        try (InputStream input = context.getAssets().open(name);
             ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int count;
            while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
            return Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP);
        }
    }

    private void assertRead(JSONObject result, String truth) throws Exception {
        assertTrue(result.toString(), result.getBoolean("success"));
        assertTrue(result.toString(), result.getBoolean("gradeable"));
        assertTrue(result.getBoolean("geometryVerified"));
        JSONArray answers = result.getJSONArray("answers");
        assertEquals(50, answers.length());
        for (int row = 0; row < 50; row++) {
            assertEquals("Question " + (row + 1), String.valueOf(truth.charAt(row)), answers.getString(row));
        }
        assertEquals(0, result.getInt("uncertainRows"));
        assertNotNull(result.getJSONObject("overlayGeometry"));
        Log.i("AcadCheck-OMR-Test", "Accepted 50/50 in " + result.getDouble("processingMs") + " ms");
    }

    @Test
    public void bundledEngineReadsUploadsAndTrackedCameraFrames() throws Exception {
        PyObject worker = worker();
        for (char choice : new char[] {'A', 'B', 'C', 'D'}) {
            String truth = new String(new char[50]).replace('\0', choice);
            JSONObject result = new JSONObject(worker.callAttr("scan_base64", fixture("all" + choice + ".jpg"), 50).toString());
            assertRead(result, truth);
        }
        String truth = "DBACBDACDBACDACCABDCBADCBADCBADCBADCBBACDCBBADCBCB";
        byte[] photo = Base64.decode(fixture("random.jpg"), Base64.DEFAULT);
        Bitmap original = BitmapFactory.decodeByteArray(photo, 0, photo.length);
        assertNotNull(original);
        try {
            int sequence = 0;
            for (int width : new int[] {1440, 1920, 1440}) {
                Bitmap resized = Bitmap.createScaledBitmap(original, width,
                    Math.round(original.getHeight() * (float) width / original.getWidth()), true);
                ByteArrayOutputStream encoded = new ByteArrayOutputStream();
                resized.compress(Bitmap.CompressFormat.JPEG, width == 1440 ? 86 : 92, encoded);
                if (resized != original) resized.recycle();
                String frame = Base64.encodeToString(encoded.toByteArray(), Base64.NO_WRAP);
                JSONObject result = new JSONObject(worker.callAttr(
                    "scan_base64", frame, 50, "instrumented-camera", String.valueOf(++sequence)
                ).toString());
                assertRead(result, truth);
            }
        } finally {
            original.recycle();
        }
    }

    @Test
    public void rotatedSheetsKeepTheirQuestionIdentity() throws Exception {
        PyObject worker = worker();
        byte[] photo = Base64.decode(fixture("random.jpg"), Base64.DEFAULT);
        Bitmap original = BitmapFactory.decodeByteArray(photo, 0, photo.length);
        assertNotNull(original);
        Bitmap source = Bitmap.createScaledBitmap(original, 1440,
            Math.round(original.getHeight() * 1440f / original.getWidth()), true);
        try {
            for (int angle : new int[] {-30, -15, 15, 30, 45, 90, 135, 180, 225, 315}) {
                Matrix rotation = new Matrix();
                rotation.postRotate(angle);
                Bitmap rotated = Bitmap.createBitmap(source, 0, 0,
                    source.getWidth(), source.getHeight(), rotation, true);
                try {
                    ByteArrayOutputStream encoded = new ByteArrayOutputStream();
                    rotated.compress(Bitmap.CompressFormat.JPEG, 92, encoded);
                    String frame = Base64.encodeToString(encoded.toByteArray(), Base64.NO_WRAP);
                    for (int sequence = 1; sequence <= 2; sequence++) {
                        JSONObject result = new JSONObject(worker.callAttr("scan_base64",
                            frame, 50, "rotation-" + angle, String.valueOf(sequence)).toString());
                        assertRead(result, "DBACBDACDBACDACCABDCBADCBADCBADCBADCBBACDCBBADCBCB");
                    }
                } finally {
                    if (rotated != source) rotated.recycle();
                }
            }
        } finally {
            if (source != original) source.recycle();
            original.recycle();
        }
    }

    @Test
    public void steadySheetKeepsACompleteReadAcrossRepeatedNativeFrames() throws Exception {
        PyObject worker = worker();
        byte[] photo = Base64.decode(fixture("random.jpg"), Base64.DEFAULT);
        Bitmap original = BitmapFactory.decodeByteArray(photo, 0, photo.length);
        assertNotNull(original);
        Bitmap resized = Bitmap.createScaledBitmap(original, 1440,
            Math.round(original.getHeight() * 1440f / original.getWidth()), true);
        ByteArrayOutputStream encoded = new ByteArrayOutputStream();
        resized.compress(Bitmap.CompressFormat.JPEG, 92, encoded);
        if (resized != original) resized.recycle();
        original.recycle();
        String frame = Base64.encodeToString(encoded.toByteArray(), Base64.NO_WRAP);
        int verifiedFastFrames = 0;
        for (int sequence = 1; sequence <= 8; sequence++) {
            JSONObject result = new JSONObject(worker.callAttr("scan_base64", frame,
                50, "steady-sheet", String.valueOf(sequence)).toString());
            assertRead(result, "DBACBDACDBACDACCABDCBADCBADCBADCBADCBBACDCBBADCBCB");
            if ("tracked-current-ring-verification".equals(result.getJSONObject("timingDetails")
                    .optString("gridVerificationMethod"))) verifiedFastFrames++;
        }
        assertTrue("The packaged engine should verify steady rings without a global refit", verifiedFastFrames > 0);
    }

    @Test
    public void emptyAndInvalidImagesCannotProduceAGrade() throws Exception {
        PyObject worker = worker();
        Bitmap image = Bitmap.createBitmap(900, 1200, Bitmap.Config.ARGB_8888);
        image.eraseColor(0xFFFFFFFF);
        ByteArrayOutputStream encoded = new ByteArrayOutputStream();
        image.compress(Bitmap.CompressFormat.JPEG, 92, encoded);
        image.recycle();
        String blank = Base64.encodeToString(encoded.toByteArray(), Base64.NO_WRAP);
        for (String input : new String[] {blank, "not-base64!"}) {
            JSONObject result = new JSONObject(worker.callAttr("scan_base64", input, 50).toString());
            assertFalse(result.toString(), result.optBoolean("gradeable"));
            assertFalse(result.optBoolean("geometryVerified"));
        }
    }
}
