package io.ionic.starter;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;

/** A4, 360 dpi RGB ESC/P-R jobs. No maintenance or persistent settings.
 * Protocol adapted from python-epson (MIT), Jason S. McMullan, 2016.
 * See assets/licenses/python-epson.txt for the complete notice and pinned source.
 */
public final class EscPrEncoder {
    public static final int DPI = 360;
    public static final int PAGE_WIDTH = 2977;
    public static final int PAGE_HEIGHT = 4210;
    public static final int MARGIN = 42; // 3 mm at 360 dpi, rounded down.
    public static final int WIDTH = PAGE_WIDTH - 2 * MARGIN;
    public static final int HEIGHT = PAGE_HEIGHT - 2 * MARGIN;

    public interface Rows {
        /** Fill exactly WIDTH opaque RGB pixels, including white background. */
        void read(int y, byte[] rgb) throws IOException;
    }

    private EscPrEncoder() {}

    public static void writeJob(OutputStream out, Rows rows) throws IOException {
        out.write(ascii("\000\000\000\033\001@EJL 1284.4\n@EJL     \n"));
        out.write(new byte[] {27, 64});
        remoteMode(out);
        remote(out, "JS", new byte[] {0, 0, 0});
        remote(out, "JH", new byte[] {0, 0, 0, 0, 0, 'A', 'c', 'a', 'd', 'C', 'h', 'e', 'c', 'k'});
        remote(out, "HD", new byte[] {3, 4});
        remote(out, "PP", new byte[] {1, 0}); // Rear sheet feeder.
        exitRemote(out);
        out.write(ascii("\033(R\006\000\000ESCPR"));
        command(out, 'q', "setq", new byte[] {0, 1, 0, 0, 0, 0, 0, 0, 0}); // Plain, normal, RGB.
        ByteBuffer page = ByteBuffer.allocate(22).order(ByteOrder.BIG_ENDIAN);
        page.putInt(PAGE_WIDTH).putInt(PAGE_HEIGHT).putShort((short) MARGIN).putShort((short) MARGIN);
        page.putInt(WIDTH).putInt(HEIGHT).put((byte) 0).put((byte) 0); // 360 dpi, bidirectional.
        command(out, 'j', "setj", page.array());
        command(out, 'p', "sttp", new byte[0]);
        command(out, 'p', "setn", new byte[] {1});
        byte[] row = new byte[WIDTH * 3];
        // Send every row so blank areas and page advancement are explicit.
        for (int y = 0; y < HEIGHT; y++) {
            if (Thread.currentThread().isInterrupted()) throw new IOException("Print job interrupted");
            rows.read(y, row);
            byte[] packed = packRgb(row);
            ByteBuffer data = ByteBuffer.allocate(7 + packed.length).order(ByteOrder.BIG_ENDIAN);
            data.putShort((short) 0).putShort((short) y).put((byte) 1);
            data.putShort((short) packed.length).put(packed);
            command(out, 'd', "dsnd", data.array());
        }
        command(out, 'p', "endp", new byte[] {0});
        command(out, 'j', "endj", new byte[0]);
        out.write(new byte[] {27, 64});
        remoteMode(out);
        remote(out, "LD", new byte[0]);
        remote(out, "JE", new byte[0]);
        exitRemote(out);
        out.flush();
    }

    /** PackBits over RGB triplets; each run is at most 128 pixels. */
    static byte[] packRgb(byte[] rgb) {
        if (rgb.length == 0 || rgb.length % 3 != 0 || rgb.length > WIDTH * 3) {
            throw new IllegalArgumentException("Invalid RGB row");
        }
        ByteArrayOutputStream packed = new ByteArrayOutputStream(rgb.length);
        for (int pixel = 0; pixel < rgb.length / 3;) {
            int repeat = 1;
            while (repeat < 128 && pixel + repeat < rgb.length / 3
                    && samePixel(rgb, pixel, pixel + repeat)) repeat++;
            packed.write(repeat == 1 ? 0 : 257 - repeat);
            packed.write(rgb, pixel * 3, 3);
            pixel += repeat;
        }
        return packed.toByteArray();
    }

    private static boolean samePixel(byte[] rgb, int a, int b) {
        return rgb[a * 3] == rgb[b * 3] && rgb[a * 3 + 1] == rgb[b * 3 + 1]
            && rgb[a * 3 + 2] == rgb[b * 3 + 2];
    }

    private static void command(OutputStream out, char group, String name, byte[] data) throws IOException {
        out.write(27);
        out.write(group);
        out.write(ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN).putInt(data.length).array());
        out.write(ascii(name));
        out.write(data);
    }

    private static void remoteMode(OutputStream out) throws IOException {
        out.write(ascii("\033(R\b\000\000REMOTE1"));
    }

    private static void exitRemote(OutputStream out) throws IOException {
        out.write(new byte[] {27, 0, 0, 0});
    }

    private static void remote(OutputStream out, String name, byte[] data) throws IOException {
        out.write(ascii(name));
        int length = data.length + 1;
        out.write(length & 255);
        out.write(length >> 8);
        out.write(0);
        out.write(data);
    }

    private static byte[] ascii(String text) {
        return text.getBytes(StandardCharsets.US_ASCII);
    }
}
