package io.ionic.starter;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

/** L120 long-bond score raster, ESC/P2 (not ESC/P-R).
 * Wire format: https://gimp-print.sourceforge.io/reference-html/c463.html
 * L120 geometry: Gutenprint model 80, baseline 360: 180 dpi nozzle pitch,
 * 59 usable colour nozzles, 60 transmitted rows, 2-bit variable drops.
 * Independent implementation restricted to RGB score labels on 8.5 x 13-inch long bond paper.
 */
public final class EscP2Encoder {
    public static final int DPI = ScorePrintLayout.DPI;
    public static final int PAGE_WIDTH = ScorePrintLayout.PAGE_WIDTH, PAGE_HEIGHT = ScorePrintLayout.PAGE_HEIGHT, MARGIN = ScorePrintLayout.MARGIN;
    public static final int WIDTH = PAGE_WIDTH - 2 * MARGIN, HEIGHT = PAGE_HEIGHT - 2 * MARGIN;
    private static final int NOZZLES = 59, WIRE_ROWS = 60, BAND_ROWS = NOZZLES * 2;
    private static final int[] HEAD_OFFSETS = {0, 0, 120, 240};
    private static final int HEAD_ORIGIN = 240;
    private static final int[] COLORS = {0, 2, 1, 4}; // K C M Y
    public interface Rows { void read(int y, byte[] rgb) throws IOException; }
    private EscP2Encoder() {}

    public static void writeJob(OutputStream out, Rows rows) throws IOException {
        out.write(new byte[] {0, 0, 0, 27, 1});
        out.write("@EJL 1284.4\n@EJL     \n".getBytes(StandardCharsets.US_ASCII));
        out.write(new byte[] {27, '@'});
        command(out, 'G', new byte[] {1}); // Graphics before any raster payload.
        command(out, 'U', new byte[] {4, 4, 4, (byte) 0xa0, 5}); // All units 1/360 inch.
        command(out, 'K', new byte[] {0, 2}); // Colour head configuration, including black caption.
        command(out, 'i', new byte[] {0}); // Host interleaving.
        out.write(new byte[] {27, 'U', 1}); // Unidirectional colour alignment.
        command(out, 'e', new byte[] {0, 16}); // Variable drops.
        command(out, 'C', le(PAGE_HEIGHT));
        command(out, 'c', concat(le(MARGIN - HEAD_ORIGIN), le(PAGE_HEIGHT - MARGIN)));
        command(out, 'S', concat(le(PAGE_WIDTH), le(PAGE_HEIGHT)));
        command(out, 'D', new byte[] {0x40, 0x38, 80, 40}); // 14400 base, 180v/360h physical dpi.
        byte[][] band = new byte[BAND_ROWS + HEAD_ORIGIN][WIDTH * 3];
        int position = 0;
        for (int base = 0; base < HEIGHT + HEAD_ORIGIN; base += BAND_ROWS) {
            if (Thread.currentThread().isInterrupted()) throw new IOException("Print job interrupted");
            for (int r = 0; r < band.length; r++) {
                Arrays.fill(band[r], (byte) 255);
                int imageY = base + r - HEAD_ORIGIN;
                if (imageY >= 0 && imageY < HEIGHT) rows.read(imageY, band[r]);
            }
            // Two passes fill alternate rows. Delayed channel data compensates
            // the staggered magenta/yellow heads; never move the paper backwards.
            for (int parity = 0; parity < 2; parity++) {
                boolean positioned = false;
                for (int color = 0; color < COLORS.length; color++) {
                    int first = WIDTH, last = -1;
                    for (int nozzle = 0; nozzle < NOZZLES; nozzle++) {
                        byte[] rgb = band[HEAD_ORIGIN + nozzle * 2 + parity - HEAD_OFFSETS[color]];
                        for (int x = 0; x < WIDTH; x++) if (drop(rgb, x, color) != 0) {
                            first = Math.min(first, x); last = Math.max(last, x);
                        }
                    }
                    if (last < 0) continue; // Never send blank page raster data.
                    if (!positioned) {
                        int target = base + parity;
                        command(out, 'v', le(target - position));
                        position = target;
                        positioned = true;
                    }
                    first -= first % 4; // Four two-bit dots per byte, most significant first.
                    int stride = ((last - first + 8) / 8) * 2; // Whole groups of eight pixels.
                    command(out, '$', le(first + MARGIN));
                    out.write(new byte[] {27, 'i', (byte) COLORS[color], 1, 2,
                        (byte) stride, (byte) (stride >> 8), WIRE_ROWS, 0});
                    byte[] plane = new byte[stride];
                    for (int nozzle = 0; nozzle < WIRE_ROWS; nozzle++) {
                        Arrays.fill(plane, (byte) 0);
                        if (nozzle < NOZZLES) {
                            byte[] rgb = band[HEAD_ORIGIN + nozzle * 2 + parity - HEAD_OFFSETS[color]];
                            for (int x = first; x <= last; x++) {
                                int local = x - first;
                                plane[local / 4] |= drop(rgb, x, color) << (6 - (local % 4) * 2);
                            }
                        }
                        out.write(pack(plane)); // PackBits resets on each nozzle row.
                    }
                    out.write(13);
                }
            }
        }
        out.write(12); // Eject exactly one completed page.
        out.write(new byte[] {27, '@'});
        out.flush();
    }

    private static int drop(byte[] rgb, int x, int color) {
        int c = 255 - (rgb[x * 3] & 255), m = 255 - (rgb[x * 3 + 1] & 255);
        int y = 255 - (rgb[x * 3 + 2] & 255), k = Math.min(c, Math.min(m, y));
        int ink = color == 0 ? k : color == 1 ? c - k : color == 2 ? m - k : y - k;
        return (ink * 3 + 127) / 255;
    }

    static byte[] pack(byte[] row) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        int p = 0;
        while (p < row.length) {
            int run = 1;
            while (p + run < row.length && run < 128 && row[p + run] == row[p]) run++;
            if (run >= 2) { out.write(257 - run); out.write(row[p]); p += run; }
            else {
                int start = p++;
                while (p < row.length && p - start < 128 &&
                    !(p + 1 < row.length && row[p] == row[p + 1])) p++;
                out.write(p - start - 1); out.write(row, start, p - start);
            }
        }
        return out.toByteArray();
    }
    private static byte[] le(int value) {
        return new byte[] {(byte) value, (byte) (value >> 8), (byte) (value >> 16), (byte) (value >> 24)};
    }
    private static byte[] concat(byte[] a, byte[] b) {
        byte[] result = Arrays.copyOf(a, a.length + b.length);
        System.arraycopy(b, 0, result, a.length, b.length); return result;
    }
    private static void command(OutputStream out, int code, byte[] args) throws IOException {
        out.write(new byte[] {27, '(', (byte) code, (byte) args.length, (byte) (args.length >> 8)});
        out.write(args);
    }
}
