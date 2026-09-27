package io.ionic.starter;

import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.regex.Pattern;

/** Pure validation shared by detection, connection and submission. */
public final class UsbPrinterPolicy {
    public static final int EPSON_VENDOR = 0x04b8;
    private static final Pattern MODEL = Pattern.compile("(^|[^A-Z0-9])L120([^A-Z0-9]|$)");

    private UsbPrinterPolicy() {}

    public static boolean isL120(int vendor, String product, String deviceId) {
        if (vendor != EPSON_VENDOR) return false;
        // Prefer the IEEE 1284 model over a generic USB product descriptor.
        String model = field(deviceId, "MDL");
        if (model.isEmpty()) model = field(deviceId, "MODEL");
        if (model.isEmpty()) model = product == null ? "" : product;
        return MODEL.matcher(model.toUpperCase(Locale.ROOT)).find();
    }

    public static String field(String id, String key) {
        if (id == null) return "";
        for (String field : id.split(";")) {
            int colon = field.indexOf(':');
            if (colon >= 0 && field.substring(0, colon).trim().equalsIgnoreCase(key)) {
                return field.substring(colon + 1).trim();
            }
        }
        return "";
    }

    public static String decodeDeviceId(byte[] data, int count) {
        if (count < 2 || count > data.length) return "";
        int declared = ((data[0] & 255) << 8) | (data[1] & 255);
        if (declared < 2 || declared > count) return "";
        return new String(data, 2, declared - 2, StandardCharsets.US_ASCII).replace("\u0000", "").trim();
    }

    public static boolean validScore(String score) {
        if (score == null || !score.matches("\\d{1,3}/\\d{1,3}")) return false;
        String[] parts = score.split("/");
        int value = Integer.parseInt(parts[0]);
        int total = Integer.parseInt(parts[1]);
        return total >= 1 && total <= 500 && value <= total;
    }
}
