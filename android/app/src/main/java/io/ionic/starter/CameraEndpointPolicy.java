package io.ionic.starter;

import java.net.URL;
import java.util.Locale;

final class CameraEndpointPolicy {
    static URL validate(String value, String method) throws Exception {
        URL url = new URL(value);
        String host = url.getHost().toLowerCase(Locale.ROOT);
        boolean local = host.equals("acadcam") || host.equals("acadacam") || host.endsWith(".local");
        String[] parts = host.split("\\.");
        if (parts.length == 4) {
            try {
                int[] octets = new int[4];
                for (int i = 0; i < 4; i++) {
                    octets[i] = Integer.parseInt(parts[i]);
                    if (octets[i] < 0 || octets[i] > 255) throw new NumberFormatException();
                }
                local |= octets[0] == 10 || (octets[0] == 172 && octets[1] >= 16 && octets[1] <= 31)
                    || (octets[0] == 192 && octets[1] == 168) || (octets[0] == 169 && octets[1] == 254);
            } catch (NumberFormatException ignored) { }
        }
        boolean endpoint = "GET".equals(method) && ("/capture".equals(url.getPath()) || "/status".equals(url.getPath()))
            || "POST".equals(method) && "/restart-camera".equals(url.getPath());
        if (!local || !endpoint || url.getUserInfo() != null
            || !("http".equals(url.getProtocol()) || "https".equals(url.getProtocol()))) {
            throw new Exception("Enter a local Raspberry Pi camera address");
        }
        return url;
    }

    static String imageType(byte[] bytes) throws Exception {
        if (bytes.length >= 4 && (bytes[0] & 255) == 255 && (bytes[1] & 255) == 216
            && (bytes[2] & 255) == 255) return "image/jpeg";
        if (bytes.length >= 8 && (bytes[0] & 255) == 137 && bytes[1] == 80 && bytes[2] == 78
            && bytes[3] == 71 && bytes[4] == 13 && bytes[5] == 10 && bytes[6] == 26 && bytes[7] == 10) return "image/png";
        throw new Exception("The camera returned an invalid image. Check the Pi camera service.");
    }
}
