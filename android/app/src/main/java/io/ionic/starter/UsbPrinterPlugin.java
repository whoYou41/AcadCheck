package io.ionic.starter;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Typeface;
import android.hardware.usb.*;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import androidx.core.content.ContextCompat;
import com.getcapacitor.*;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.BufferedOutputStream;
import java.io.IOException;
import java.util.Arrays;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

@CapacitorPlugin(name = "UsbPrinter")
public class UsbPrinterPlugin extends Plugin {
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private final AtomicBoolean busy = new AtomicBoolean();
    private UsbManager manager;
    private String permissionAction;
    private volatile String selectedName;
    private volatile String selectedModel;
    private volatile boolean destroyed;
    private boolean receiverRegistered;
    private PluginCall permissionCall;
    private String permissionDevice;
    private PendingIntent permissionIntent;
    private Runnable permissionTimeout;

    @Override public void load() {
        manager = (UsbManager) getContext().getSystemService(Context.USB_SERVICE);
        permissionAction = getContext().getPackageName() + ".USB_PRINTER_PERMISSION";
        IntentFilter filter = new IntentFilter(permissionAction);
        filter.addAction(UsbManager.ACTION_USB_DEVICE_ATTACHED);
        filter.addAction(UsbManager.ACTION_USB_DEVICE_DETACHED);
        ContextCompat.registerReceiver(getContext(), receiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED);
        receiverRegistered = true;
    }

    private final BroadcastReceiver receiver = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) {
            if (permissionAction.equals(intent.getAction())) {
                // Trust the OS permission state, never just broadcast extras.
                PluginCall call = permissionCall;
                if (call == null) return;
                UsbDevice device = manager.getDeviceList().get(permissionDevice);
                clearPermission();
                if (device == null || !manager.hasPermission(device)) {
                    busy.set(false);
                    call.reject("USB access was denied or the printer was disconnected.", "USB_PERMISSION_DENIED");
                } else {
                    worker.execute(() -> connectDevice(call, device));
                }
                return;
            }
            UsbDevice device = intent.getParcelableExtra(UsbManager.EXTRA_DEVICE);
            if (UsbManager.ACTION_USB_DEVICE_DETACHED.equals(intent.getAction()) && device != null) {
                if (device.getDeviceName().equals(selectedName)) {
                    selectedName = null;
                    selectedModel = null;
                }
                if (device.getDeviceName().equals(permissionDevice) && permissionCall != null) {
                    PluginCall call = permissionCall;
                    clearPermission();
                    busy.set(false);
                    call.reject("Printer disconnected while requesting access.", "USB_DISCONNECTED");
                }
            }
            notifyListeners("devicesChanged", status());
        }
    };

    @PluginMethod public void getStatus(PluginCall call) { call.resolve(status()); }

    @Override protected void handleOnResume() {
        if (manager != null) notifyListeners("devicesChanged", status());
    }

    private JSObject status() {
        JSObject result = new JSObject();
        result.put("usbHostSupported", manager != null &&
            getContext().getPackageManager().hasSystemFeature(PackageManager.FEATURE_USB_HOST));
        JSArray devices = new JSArray();
        if (manager != null) {
            for (UsbDevice device : manager.getDeviceList().values()) {
                if (device.getVendorId() != UsbPrinterPolicy.EPSON_VENDOR || printerInterface(device) == null) continue;
                JSObject item = new JSObject();
                item.put("deviceName", device.getDeviceName());
                item.put("productName", product(device));
                item.put("vendorId", device.getVendorId());
                item.put("productId", device.getProductId());
                item.put("permissionGranted", manager.hasPermission(device));
                devices.put(item);
            }
        }
        result.put("devices", devices);
        UsbDevice selected = manager == null || selectedName == null ? null : manager.getDeviceList().get(selectedName);
        boolean connected = selected != null && manager.hasPermission(selected);
        result.put("connected", connected);
        result.put("printerName", connected ? selectedModel : "");
        result.put("busy", busy.get());
        return result;
    }

    @PluginMethod public void connect(PluginCall call) {
        if (destroyed || manager == null) { call.reject("USB host is unavailable.", "USB_UNAVAILABLE"); return; }
        if (!busy.compareAndSet(false, true)) { call.reject("A printer operation is already running.", "USB_BUSY"); return; }
        String name = call.getString("deviceName", "");
        UsbDevice device = manager.getDeviceList().get(name);
        if (device == null || device.getVendorId() != UsbPrinterPolicy.EPSON_VENDOR || printerInterface(device) == null) {
            busy.set(false);
            call.reject("Connect the Epson L120 using an OTG adapter and its USB printer cable.", "USB_NOT_FOUND");
            return;
        }
        if (manager.hasPermission(device)) { worker.execute(() -> connectDevice(call, device)); return; }
        main.post(() -> {
            if (destroyed) { busy.set(false); call.reject("App closed.", "USB_CLOSED"); return; }
            permissionCall = call;
            permissionDevice = device.getDeviceName();
            permissionIntent = PendingIntent.getBroadcast(getContext(), 0,
                new Intent(permissionAction).setPackage(getContext().getPackageName()),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            permissionTimeout = () -> {
                if (permissionCall != call) return;
                clearPermission();
                busy.set(false);
                call.reject("USB permission request timed out. Tap Connect to try again.", "USB_PERMISSION_TIMEOUT");
            };
            main.postDelayed(permissionTimeout, 20000);
            try { manager.requestPermission(device, permissionIntent); }
            catch (Exception e) {
                clearPermission();
                busy.set(false);
                call.reject("Could not request USB access.", "USB_PERMISSION_FAILED", e);
            }
        });
    }

    private void clearPermission() {
        if (permissionTimeout != null) main.removeCallbacks(permissionTimeout);
        if (permissionIntent != null) permissionIntent.cancel();
        permissionCall = null;
        permissionDevice = null;
        permissionTimeout = null;
        permissionIntent = null;
    }

    private void connectDevice(PluginCall call, UsbDevice device) {
        selectedName = null;
        selectedModel = null;
        try (Session session = open(device)) {
            selectedName = device.getDeviceName();
            selectedModel = "Epson L120";
            JSObject result = new JSObject();
            result.put("connected", true);
            result.put("printerName", selectedModel);
            call.resolve(result);
        } catch (Exception e) {
            call.reject(e.getMessage(), "USB_CONNECT_FAILED", e);
        } finally {
            busy.set(false);
            notifyListeners("devicesChanged", status());
        }
    }

    @PluginMethod public void disconnect(PluginCall call) {
        if (busy.get()) { call.reject("Wait for the current printer operation to finish.", "USB_BUSY"); return; }
        selectedName = null;
        selectedModel = null;
        call.resolve(status());
        notifyListeners("devicesChanged", status());
    }

    @PluginMethod public void printScore(PluginCall call) {
        String score = call.getString("scoreText");
        boolean testPage = call.getBoolean("testPage", false);
        if (!UsbPrinterPolicy.validScore(score)) {
            call.reject("A valid saved score is required.", "INVALID_SCORE"); return;
        }
        if (destroyed || manager == null) { call.reject("USB host is unavailable.", "USB_UNAVAILABLE"); return; }
        if (!busy.compareAndSet(false, true)) { call.reject("A printer operation is already running.", "USB_BUSY"); return; }
        String deviceName = selectedName;
        worker.execute(() -> {
            try {
                UsbDevice device = deviceName == null ? null : manager.getDeviceList().get(deviceName);
                if (device == null || !manager.hasPermission(device)) {
                    selectedName = null;
                    selectedModel = null;
                    throw new IOException("Connect the Epson L120 before printing.");
                }
                try (Session session = open(device)) {
                    checkPaper(session);
                    ScoreRows rows = new ScoreRows(score, call.getArray("questionResults"));
                    try {
                        UsbPrintOutput output = new UsbPrintOutput(new UsbPrintOutput.Transport() {
                            public long now() { return SystemClock.elapsedRealtime(); }
                            public boolean connected() {
                                return !destroyed && manager.getDeviceList().containsKey(deviceName);
                            }
                            public int send(byte[] data, int offset, int length, int timeoutMs) {
                                return session.connection.bulkTransfer(session.endpoint, data, offset, length, timeoutMs);
                            }
                        });
                        // Buffer small commands; never automatically replay a failed/partial job.
                        EscP2Encoder.writeJob(new BufferedOutputStream(output, 8192), rows);
                        JSObject result = new JSObject();
                        result.put("submitted", true);
                        result.put("printerName", "Epson L120");
                        result.put("bytesSent", output.bytesSent);
                        result.put("completionConfirmed", false);
                        call.resolve(result);
                    } finally { rows.close(); }
                }
            } catch (Exception e) {
                call.reject(e.getMessage() + " The page may be incomplete; check the printer before retrying.",
                    "USB_PRINT_FAILED", e);
            } finally {
                busy.set(false);
                notifyListeners("devicesChanged", status());
            }
        });
    }

    private Session open(UsbDevice device) throws IOException {
        if (destroyed || !manager.hasPermission(device)) throw new IOException("USB access is unavailable.");
        UsbInterface iface = printerInterface(device);
        if (iface == null) throw new IOException("No compatible USB printer interface was found.");
        UsbDeviceConnection connection = manager.openDevice(device);
        if (connection == null) throw new IOException("Could not open the printer. Reconnect the OTG cable.");
        if (!connection.claimInterface(iface, false)) {
            connection.close();
            throw new IOException("The printer is in use. Close other printer connections and try again.");
        }
        Session session = new Session(connection, iface, outputEndpoint(iface));
        try {
            if (iface.getAlternateSetting() != 0 && !connection.setInterface(iface)) {
                throw new IOException("Could not select the USB printer interface.");
            }
            byte[] id = new byte[2048];
            int count = connection.controlTransfer(0xa1, 0, 0,
                (iface.getId() << 8) | iface.getAlternateSetting(), id, id.length, 800);
            String deviceId = UsbPrinterPolicy.decodeDeviceId(id, count);
            if (!UsbPrinterPolicy.isL120(device.getVendorId(), product(device), deviceId)) {
                throw new IOException("This printing profile supports Epson L120 only. Detected: " + product(device));
            }
            return session;
        } catch (Exception e) { session.close(); throw e; }
    }

    private static void checkPaper(Session session) throws IOException {
        byte[] status = new byte[1];
        int count = session.connection.controlTransfer(0xa1, 1, 0, session.iface.getId(), status, 1, 1000);
        // Some firmware does not implement GET_PORT_STATUS; lack of status is not proof of completion.
        if (count != 1) return;
        if ((status[0] & 0x20) != 0) throw new IOException("The printer is out of paper. Load 8.5 x 13-inch long bond paper, bottom/QR edge first.");
        if ((status[0] & 0x08) == 0) throw new IOException("The printer reports an error. Check its lights and paper feed.");
    }

    private static UsbInterface printerInterface(UsbDevice device) {
        UsbInterface best = null;
        for (int i = 0; i < device.getInterfaceCount(); i++) {
            UsbInterface candidate = device.getInterface(i);
            // Protocol 3 requires IEEE 1284.4 transport, not raw bulk output.
            if (candidate.getInterfaceClass() != UsbConstants.USB_CLASS_PRINTER ||
                candidate.getInterfaceSubclass() != 1 ||
                (candidate.getInterfaceProtocol() != 1 && candidate.getInterfaceProtocol() != 2) ||
                outputEndpoint(candidate) == null) continue;
            if (best == null || (best.getAlternateSetting() != 0 && candidate.getAlternateSetting() == 0)) best = candidate;
        }
        return best;
    }

    private static UsbEndpoint outputEndpoint(UsbInterface iface) {
        for (int i = 0; i < iface.getEndpointCount(); i++) {
            UsbEndpoint endpoint = iface.getEndpoint(i);
            if (endpoint.getType() == UsbConstants.USB_ENDPOINT_XFER_BULK &&
                endpoint.getDirection() == UsbConstants.USB_DIR_OUT) return endpoint;
        }
        return null;
    }

    private static String product(UsbDevice device) {
        String name = device.getProductName();
        return name == null || name.trim().isEmpty() ? "Epson USB printer" : name;
    }

    private static class Session implements AutoCloseable {
        final UsbDeviceConnection connection;
        final UsbInterface iface;
        final UsbEndpoint endpoint;
        Session(UsbDeviceConnection connection, UsbInterface iface, UsbEndpoint endpoint) {
            this.connection = connection; this.iface = iface; this.endpoint = endpoint;
        }
        @Override public void close() { connection.releaseInterface(iface); connection.close(); }
    }

    /** Sparse long-bond raster for the saved score and answer outcomes. */
    private static class ScoreRows implements EscP2Encoder.Rows, AutoCloseable {
        final Bitmap label;
        final int left;
        final int top;
        final int[] pixels;
        final List<Bitmap> marks = new ArrayList<>();
        final List<int[]> markPositions = new ArrayList<>();
        ScoreRows(String score, JSONArray outcomes) {
            int dpi = EscP2Encoder.DPI;
            label = Bitmap.createBitmap(ScorePrintLayout.LABEL_WIDTH, ScorePrintLayout.LABEL_HEIGHT, Bitmap.Config.ARGB_8888);
            label.eraseColor(Color.WHITE);
            Canvas canvas = new Canvas(label);
            Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
            paint.setColor(Color.RED);
            paint.setStyle(Paint.Style.STROKE);
            paint.setStrokeWidth(dpi * 0.012f);
            paint.setTextSize(dpi * 0.20f);
            float available = label.getWidth() - dpi * 0.08f;
            if (paint.measureText(score) > available) paint.setTextSize(paint.getTextSize() * available / paint.measureText(score));
            paint.setTypeface(Typeface.create(Typeface.DEFAULT, Typeface.BOLD));
            paint.setTextAlign(Paint.Align.CENTER);
            float x = label.getWidth() / 2f, y = label.getHeight() / 2f;
            canvas.save();
            canvas.rotate(ScorePrintLayout.ROTATION_DEGREES, x, y);
            canvas.drawText(score, x, y - (paint.ascent() + paint.descent()) / 2f, paint);
            canvas.restore();
            left = ScorePrintLayout.LEFT;
            top = ScorePrintLayout.TOP;
            pixels = new int[label.getWidth()];
            if (outcomes != null) {
                for (int i = 0; i < outcomes.length(); i++) {
                    JSONObject outcome = outcomes.optJSONObject(i);
                    if (outcome == null) continue;
                    int question = outcome.optInt("questionNumber", outcome.optInt("question_number", 0));
                    if (question < 1 || question > 50) continue;
                    boolean correct = outcome.optBoolean("isCorrect", outcome.optBoolean("is_correct", false));
                    int size = ScorePrintLayout.QUESTION_MARK_SIZE;
                    Bitmap mark = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
                    mark.eraseColor(Color.TRANSPARENT);
                    Canvas markCanvas = new Canvas(mark);
                    Paint markPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
                    markPaint.setColor(correct ? Color.rgb(22, 131, 59) : Color.rgb(213, 43, 43));
                    markPaint.setStyle(Paint.Style.STROKE);
                    markPaint.setStrokeWidth(Math.max(2.5f, size * 0.19f));
                    markPaint.setStrokeCap(Paint.Cap.ROUND);
                    markPaint.setStrokeJoin(Paint.Join.ROUND);
                    float mid = size / 2f;
                    markCanvas.save();
                    markCanvas.rotate(ScorePrintLayout.ROTATION_DEGREES, mid, mid);
                    if (correct) {
                        markCanvas.drawLines(new float[] { mid - 16, mid + 2,
                            mid - 6, mid + 12,
                            mid - 6, mid + 12,
                            mid + 16, mid - 15 }, markPaint);
                    } else {
                        markCanvas.drawLine(mid - 16, mid - 16, mid + 16, mid + 16, markPaint);
                        markCanvas.drawLine(mid + 16, mid - 16, mid - 16, mid + 16, markPaint);
                    }
                    markCanvas.restore();
                    int uprightX = ScorePrintLayout.questionX(question);
                    int uprightY = ScorePrintLayout.questionY(question);
                    marks.add(mark);
                    markPositions.add(new int[] {
                        ScorePrintLayout.PAGE_WIDTH - uprightX - size / 2 - ScorePrintLayout.MARGIN,
                        ScorePrintLayout.PAGE_HEIGHT - uprightY - size / 2 - ScorePrintLayout.MARGIN
                    });
                }
            }
        }
        @Override public void read(int y, byte[] rgb) {
            Arrays.fill(rgb, (byte) 255);
            if (y >= top && y < top + label.getHeight()) {
                label.getPixels(pixels, 0, pixels.length, 0, y - top, pixels.length, 1);
                copyPixels(rgb, pixels, left, false);
            }
            for (int i = 0; i < marks.size(); i++) {
                int[] position = markPositions.get(i);
                if (y < position[1] || y >= position[1] + marks.get(i).getHeight()) continue;
                int[] markPixels = new int[marks.get(i).getWidth()];
                marks.get(i).getPixels(markPixels, 0, markPixels.length, 0, y - position[1], markPixels.length, 1);
                copyPixels(rgb, markPixels, position[0], true);
            }
        }
        private static void copyPixels(byte[] rgb, int[] row, int left, boolean compositeAlpha) {
            for (int x = 0; x < row.length; x++) {
                int position = (left + x) * 3;
                int alpha = compositeAlpha ? row[x] >>> 24 : 255;
                int red = ((row[x] >> 16) & 255) * alpha / 255 + 255 - alpha;
                int green = ((row[x] >> 8) & 255) * alpha / 255 + 255 - alpha;
                int blue = (row[x] & 255) * alpha / 255 + 255 - alpha;
                rgb[position] = (byte) red;
                rgb[position + 1] = (byte) green;
                rgb[position + 2] = (byte) blue;
            }
        }
        @Override public void close() {
            label.recycle();
            for (Bitmap mark : marks) mark.recycle();
        }
    }

    @Override protected void handleOnDestroy() {
        destroyed = true;
        if (receiverRegistered) getContext().unregisterReceiver(receiver);
        if (permissionCall != null) {
            permissionCall.reject("App closed during USB permission request.", "USB_CLOSED");
            clearPermission();
        }
        worker.shutdownNow();
    }
}
