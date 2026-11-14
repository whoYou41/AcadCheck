package io.ionic.starter;

import android.app.Activity;
import androidx.activity.result.ActivityResult;
import android.content.ContentValues;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.DocumentsContract;
import android.provider.MediaStore;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.OutputStream;

@CapacitorPlugin(name = "DeviceFileExport")
public class DeviceFileExportPlugin extends Plugin {
    private static final int MAX_ENCODED_BYTES = 32 * 1024 * 1024;

    @PluginMethod
    public void saveToDownloads(PluginCall call) {
        String requestedName = call.getString("fileName", "AcadCheck-export.bin");
        String mimeType = call.getString("mimeType", "application/octet-stream");
        String encoded = call.getString("base64", "");
        String fileName = safeFileName(requestedName);
        if (encoded.isEmpty() || encoded.length() > MAX_ENCODED_BYTES) {
            call.reject("The export is empty or too large to save.", "INVALID_EXPORT");
            return;
        }
        final byte[] contents;
        try {
            contents = Base64.decode(encoded, Base64.DEFAULT);
        } catch (IllegalArgumentException error) {
            call.reject("The export data could not be decoded.", "INVALID_EXPORT", error);
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            saveInPublicDownloads(call, contents, fileName, mimeType);
        } else {
            Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType(mimeType);
            intent.putExtra(Intent.EXTRA_TITLE, fileName);
            try {
                intent.putExtra(DocumentsContract.EXTRA_INITIAL_URI, DocumentsContract.buildDocumentUri(
                    "com.android.externalstorage.documents", "primary:Download"));
            } catch (Exception ignored) { }
            startActivityForResult(call, intent, "saveFilePickerResult");
        }
    }

    private void saveInPublicDownloads(PluginCall call, byte[] contents, String fileName, String mimeType) {
        Uri destination = null;
        try {
            ContentValues values = new ContentValues();
            values.put(MediaStore.Downloads.DISPLAY_NAME, fileName);
            values.put(MediaStore.Downloads.MIME_TYPE, mimeType);
            values.put(MediaStore.Downloads.RELATIVE_PATH,
                Environment.DIRECTORY_DOWNLOADS + "/AcadCheck");
            values.put(MediaStore.Downloads.IS_PENDING, 1);
            destination = getContext().getContentResolver().insert(
                MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (destination == null) throw new IllegalStateException("Android could not create a Downloads file.");
            try (OutputStream output = getContext().getContentResolver().openOutputStream(destination, "w")) {
                if (output == null) throw new IllegalStateException("Android could not open the Downloads file.");
                output.write(contents);
                output.flush();
            }
            ContentValues ready = new ContentValues();
            ready.put(MediaStore.Downloads.IS_PENDING, 0);
            getContext().getContentResolver().update(destination, ready, null, null);
            resolveSaved(call, fileName, "Download/AcadCheck");
        } catch (Exception error) {
            if (destination != null) getContext().getContentResolver().delete(destination, null, null);
            call.reject("Could not save the export to Downloads: " + error.getMessage(), "SAVE_FAILED", error);
        }
    }

    @ActivityCallback
    private void saveFilePickerResult(PluginCall call, ActivityResult result) {
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null
                || result.getData().getData() == null) {
            JSObject cancelled = new JSObject();
            cancelled.put("saved", false);
            cancelled.put("cancelled", true);
            call.resolve(cancelled);
            return;
        }
        Uri destination = result.getData().getData();
        String requestedName = call.getString("fileName", "AcadCheck-export.bin");
        String fileName = safeFileName(requestedName);
        String encoded = call.getString("base64", "");
        try {
            byte[] contents = Base64.decode(encoded, Base64.DEFAULT);
            try (OutputStream output = getContext().getContentResolver().openOutputStream(destination, "w")) {
                if (output == null) throw new IllegalStateException("The selected file could not be opened.");
                output.write(contents);
                output.flush();
            }
            resolveSaved(call, fileName, destination.toString());
        } catch (Exception error) {
            call.reject("Could not save the selected file: " + error.getMessage(), "SAVE_FAILED", error);
        }
    }

    private void resolveSaved(PluginCall call, String fileName, String location) {
        JSObject result = new JSObject();
        result.put("saved", true);
        result.put("cancelled", false);
        result.put("fileName", fileName);
        result.put("location", location);
        call.resolve(result);
    }

    private String safeFileName(String value) {
        String safe = value == null ? "AcadCheck-export.bin" : value.replaceAll("[\\\\/:*?\"<>|]", "-").trim();
        if (safe.isEmpty() || safe.equals(".") || safe.equals("..")) return "AcadCheck-export.bin";
        return safe.length() > 160 ? safe.substring(safe.length() - 160) : safe;
    }
}
