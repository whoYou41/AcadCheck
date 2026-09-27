package io.ionic.starter;

import com.chaquo.python.PyObject;
import com.chaquo.python.Python;
import com.chaquo.python.android.AndroidPlatform;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.atomic.AtomicBoolean;

@CapacitorPlugin(name = "OfflineOmr")
public class OfflineOmrPlugin extends Plugin {
    private static final Object PYTHON_LOCK = new Object();
    private static final AtomicBoolean scanInFlight = new AtomicBoolean(false);
    // One queue for the process: activity recreation must not run two scans
    // concurrently against the same OpenCV-DNN network and tracking cache.
    private static final ExecutorService executor = Executors.newSingleThreadExecutor();

    private PyObject module() {
        synchronized (PYTHON_LOCK) {
            if (!Python.isStarted()) {
                Python.start(new AndroidPlatform(getContext()));
            }
            return Python.getInstance().getModule("mobile_omr");
        }
    }

    @Override
    public void load() {
        super.load();
        executor.submit(() -> {
            try {
                module().callAttr("prewarm");
            } catch (Exception error) {
                android.util.Log.e("AcadCheck-OMR", "Native detector warmup failed", error);
            }
        });
    }

    @PluginMethod
    public void prewarm(PluginCall call) {
        if (executor.isShutdown()) {
            call.reject("The offline OMR worker is unavailable");
            return;
        }
        executor.submit(() -> {
            try {
                String json = module().callAttr("prewarm").toString();
                call.resolve(new JSObject(json));
            } catch (Exception error) {
                call.reject("Could not initialize offline OMR", error);
            }
        });
    }

    @PluginMethod
    public void scan(PluginCall call) {
        String imageBase64 = call.getString("imageBase64");
        Integer requestedCount = call.getInt("questionCount", 50);
        String trackingSessionId = call.getString("trackingSessionId", "");
        String frameId = call.getString("frameId", "");
        if (imageBase64 == null || imageBase64.isEmpty()) {
            call.reject("A JPEG or PNG image is required");
            return;
        }
        if (imageBase64.length() > 32 * 1024 * 1024) {
            call.reject("The selected image is too large");
            return;
        }
        int questionCount = Math.max(1, Math.min(50, requestedCount == null ? 50 : requestedCount));
        if (executor.isShutdown()) {
            call.reject("The offline OMR worker is unavailable");
            return;
        }
        // Keep the backlog bounded across activity/page recreation as well
        // as within one WebView. Old frames must not delay a new live sheet.
        if (!scanInFlight.compareAndSet(false, true)) {
            call.reject("The offline scanner is already reading a frame");
            return;
        }
        try {
            executor.submit(() -> {
                try {
                    String json = module()
                        .callAttr("scan_base64", imageBase64, questionCount, trackingSessionId, frameId)
                        .toString();
                    call.resolve(new JSObject(json));
                } catch (Exception error) {
                    call.reject("Offline OMR processing failed", error);
                } finally {
                    scanInFlight.set(false);
                }
            });
        } catch (RejectedExecutionException error) {
            scanInFlight.set(false);
            call.reject("The offline OMR worker is unavailable", error);
        }
    }

}
