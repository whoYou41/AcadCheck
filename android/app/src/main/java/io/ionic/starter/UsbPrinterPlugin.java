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
            main.postDelayed(permissionTimeout, 60000);
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
                    ScoreRows rows = new ScoreRows(score);
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
                (iface.getId() << 8) | iface.getAlternateSetting(), id, id.length, 1500);
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

    /** A narrow bitmap keeps memory bounded; all other page pixels are white. */
    private static class ScoreRows implements EscP2Encoder.Rows, AutoCloseable {
        final Bitmap label;
        final int left;
        final int top;
        final int[] pixels;
        ScoreRows(String score) {
            int dpi = EscP2Encoder.DPI;
            label = Bitmap.createBitmap(ScorePrintLayout.LABEL_WIDTH, ScorePrintLayout.LABEL_HEIGHT, Bitmap.Config.ARGB_8888);
            label.eraseColor(Color.WHITE);
            Canvas canvas = new Canvas(label);
            Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
            paint.setColor(Color.RED);
            paint.setStyle(Paint.Style.STROKE);
            paint.setStrokeWidth(dpi * 0.012f);
            paint.setTextSize(dpi * 0.20f);
            // Keep even a three-digit total inside the same heading-side box.
            float available = label.getWidth() - dpi * 0.08f;
            if (paint.measureText(score) > available)
                paint.setTextSize(paint.getTextSize() * available / paint.measureText(score));
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
        }
        @Override public void read(int y, byte[] rgb) {
            Arrays.fill(rgb, (byte) 255);
            if (y < top || y >= top + label.getHeight()) return;
            label.getPixels(pixels, 0, pixels.length, 0, y - top, pixels.length, 1);
            for (int x = 0; x < pixels.length; x++) {
                int position = (left + x) * 3;
                rgb[position] = (byte) (pixels[x] >> 16);
                rgb[position + 1] = (byte) (pixels[x] >> 8);
                rgb[position + 2] = (byte) pixels[x];
            }
        }
        @Override public void close() { label.recycle(); }
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
