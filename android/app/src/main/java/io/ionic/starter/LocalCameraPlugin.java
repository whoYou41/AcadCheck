package io.ionic.starter;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.util.Base64;
import android.view.WindowManager;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import org.json.JSONTokener;

/** Camera traffic must stay on Wi-Fi even when Android uses cellular for internet. */
@CapacitorPlugin(name = "LocalCamera")
public class LocalCameraPlugin extends Plugin {
    private final ExecutorService executor = Executors.newFixedThreadPool(3);
    private final ScheduledExecutorService deadlines = Executors.newSingleThreadScheduledExecutor();
    private final Map<String, Request> requests = new ConcurrentHashMap<>();

    private static class Request {
        final PluginCall call;
        Request(PluginCall call) { this.call = call; }
        volatile HttpURLConnection connection;
        volatile Future<?> task;
        volatile boolean cancelled;
        synchronized void cancel() {
            cancelled = true;
            if (connection != null) connection.disconnect();
            if (task != null) task.cancel(true);
        }
        synchronized void attach(HttpURLConnection value) throws Exception {
            if (cancelled) { value.disconnect(); throw new Exception("Camera request cancelled"); }
            connection = value;
        }
    }

    private Network localNetwork() throws Exception {
        ConnectivityManager manager = (ConnectivityManager) getContext().getSystemService(Context.CONNECTIVITY_SERVICE);
        Network active = manager.getActiveNetwork();
        if (isLocal(manager, active)) return active;
        for (Network network : manager.getAllNetworks()) if (isLocal(manager, network)) return network;
        throw new Exception("Connect this phone to the Pi Wi-Fi. Internet access is not required.");
    }

    private boolean isLocal(ConnectivityManager manager, Network network) {
        NetworkCapabilities capabilities = network == null ? null : manager.getNetworkCapabilities(network);
        return capabilities != null && !capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN)
            && (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
                || capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET));
    }

    @PluginMethod
    public void request(PluginCall call) {
        String id = call.getString("requestId");
        if (id == null) { call.reject("Missing camera request ID"); return; }
        Request request = new Request(call);
        if (requests.putIfAbsent(id, request) != null) { call.reject("Duplicate camera request ID"); return; }
        boolean image = "blob".equals(call.getString("responseType"));
        Future<?> deadline = deadlines.schedule(() -> {
            if (requests.remove(id, request)) {
                call.reject("Camera request timeout", "CAMERA_TIMEOUT");
                request.cancel();
            }
        }, image ? 17 : 5, TimeUnit.SECONDS);
        request.task = executor.submit(() -> {
            try {
                URL url = CameraEndpointPolicy.validate(call.getString("url"), call.getString("method", "GET"));
                HttpURLConnection connection = (HttpURLConnection) localNetwork().openConnection(url);
                request.attach(connection);
                connection.setConnectTimeout(image ? 4000 : 2000);
                connection.setReadTimeout(image ? 12000 : 2500);
                connection.setInstanceFollowRedirects(false);
                connection.setUseCaches(false);
                connection.setRequestMethod(call.getString("method", "GET"));
                connection.setRequestProperty("Accept", image ? "image/jpeg,image/png" : "application/json");
                if ("POST".equals(connection.getRequestMethod())) {
                    connection.setDoOutput(true);
                    connection.setFixedLengthStreamingMode(2);
                    connection.setRequestProperty("Content-Type", "application/json");
                    try (java.io.OutputStream output = connection.getOutputStream()) { output.write(new byte[]{'{', '}'}); }
                }
                int status = connection.getResponseCode();
                byte[] bytes;
                try (InputStream input = status < 400 ? connection.getInputStream() : connection.getErrorStream();
                     ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                    byte[] buffer = new byte[16384];
                    int size;
                    while (input != null && (size = input.read(buffer)) != -1) {
                        if (request.cancelled) return;
                        if (output.size() + size > (image ? 20 * 1024 * 1024 : 1024 * 1024)) throw new Exception("Camera response is too large");
                        output.write(buffer, 0, size);
                    }
                    bytes = output.toByteArray();
                }
                JSObject result = new JSObject();
                result.put("status", status);
                result.put("url", url.toString());
                JSObject headers = new JSObject();
                if (image && status >= 200 && status < 300) {
                    String mime = CameraEndpointPolicy.imageType(bytes);
                    headers.put("content-type", mime);
                    result.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP));
                } else {
                    String value = new String(bytes, java.nio.charset.StandardCharsets.UTF_8);
                    try { result.put("data", new JSONTokener(value).nextValue()); }
                    catch (Exception invalidJson) { result.put("data", value); }
                }
                result.put("headers", headers);
                if (requests.remove(id, request)) call.resolve(result);
            } catch (Exception error) {
                if (requests.remove(id, request)) call.reject(error.getMessage(), "CAMERA_CONNECTION", error);
            } finally {
                deadline.cancel(false);
                if (request.connection != null) request.connection.disconnect();
            }
        });
        if (request.cancelled) request.task.cancel(true);
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        String id = call.getString("requestId");
        Request request = id == null ? null : requests.remove(id);
        if (request != null) {
            request.call.reject("Camera request cancelled", "CAMERA_CANCELLED");
            request.cancel();
        }
        call.resolve();
    }

    @PluginMethod
    public void setActive(PluginCall call) {
        boolean active = Boolean.TRUE.equals(call.getBoolean("active", false));
        getActivity().runOnUiThread(() -> {
            if (active) getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            call.resolve();
        });
    }

    @Override
    protected void handleOnDestroy() {
        for (Request request : requests.values()) request.cancel();
        requests.clear();
        executor.shutdownNow();
        deadlines.shutdownNow();
    }
}
