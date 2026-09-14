package io.ionic.starter;

import org.junit.Test;
import java.io.*;
import java.nio.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import static org.junit.Assert.*;

public class EscPrEncoderTest {
    private byte[] unpack(byte[] packed) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        int p = 0;
        while (p < packed.length) {
            int control = packed[p++] & 255;
            if (control <= 127) {
                int count = (control + 1) * 3;
                out.write(packed, p, count);
                p += count;
            } else if (control != 128) {
                int count = 257 - control;
                for (int i = 0; i < count; i++) out.write(packed, p, 3);
                p += 3;
            } else fail("Reserved PackBits marker");
        }
        return out.toByteArray();
    }

    @Test public void rgbRunsRoundTripAtBoundariesAndWithDistinctChannels() throws Exception {
        for (int count : new int[] {1, 2, 127, 128, 129, EscPrEncoder.WIDTH}) {
            byte[] row = new byte[count * 3];
            for (int i = 0; i < count; i++) { row[i * 3] = (byte) 255; row[i * 3 + 2] = 25; }
            assertArrayEquals(row, unpack(EscPrEncoder.packRgb(row)));
        }
        byte[] random = new byte[EscPrEncoder.WIDTH * 3];
        new Random(3210).nextBytes(random);
        assertArrayEquals(random, unpack(EscPrEncoder.packRgb(random)));
    }

    @Test public void a4JobHasCorrectFramesCoordinatesAndCompleteRgbRows() throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        EscPrEncoder.writeJob(out, (y, row) -> {
            Arrays.fill(row, (byte) 255);
            if (y == 100) { row[0] = (byte) 255; row[1] = 0; row[2] = 0; }
        });
        byte[] bytes = out.toByteArray();
        byte[] marker = "\033(R\006\000\000ESCPR".getBytes(StandardCharsets.US_ASCII);
        int p = indexOf(bytes, marker) + marker.length;
        assertTrue(p >= marker.length);
        int rows = 0;
        List<String> names = new ArrayList<>();
        while (p < bytes.length && bytes[p] == 27 && bytes[p + 1] != 64) {
            int length = ByteBuffer.wrap(bytes, p + 2, 4).order(ByteOrder.LITTLE_ENDIAN).getInt();
            String name = new String(bytes, p + 6, 4, StandardCharsets.US_ASCII);
            names.add(name);
            ByteBuffer data = ByteBuffer.wrap(bytes, p + 10, length).slice().order(ByteOrder.BIG_ENDIAN);
            if (name.equals("setj")) {
                assertEquals(22, length);
                assertEquals(2977, data.getInt());
                assertEquals(4210, data.getInt());
                assertEquals(42, data.getShort());
                assertEquals(42, data.getShort());
                assertEquals(2893, data.getInt());
                assertEquals(4126, data.getInt());
                assertEquals(0, data.get());
                assertEquals(0, data.get());
            } else if (name.equals("dsnd")) {
                assertEquals(0, data.getShort());
                assertEquals(rows, data.getShort() & 65535);
                assertEquals(1, data.get());
                int packedSize = data.getShort() & 65535;
                assertEquals(length - 7, packedSize);
                byte[] packed = new byte[packedSize];
                data.get(packed);
                byte[] rgb = unpack(packed);
                assertEquals(2893 * 3, rgb.length);
                assertEquals(255, rgb[0] & 255);
                assertEquals(rows == 100 ? 0 : 255, rgb[1] & 255);
                rows++;
            }
            p += 10 + length;
        }
        assertEquals(4126, rows);
        assertEquals(Arrays.asList("setq", "setj", "sttp", "setn"), names.subList(0, 4));
        assertEquals(Arrays.asList("endp", "endj"), names.subList(names.size() - 2, names.size()));
        assertTrue(bytes.length < 600000); // White A4 rows stay small; no full-page bitmap.
        assertEquals(27, bytes[p]); assertEquals(64, bytes[p + 1]);
    }

    @Test public void failedOutputStopsWithoutReplayingOrFinishingJob() throws Exception {
        final int[] attempted = {0};
        OutputStream broken = new OutputStream() {
            @Override public void write(int value) throws IOException {
                if (++attempted[0] > 300) throw new IOException("Cable removed");
            }
        };
        try {
            EscPrEncoder.writeJob(broken, (y, row) -> Arrays.fill(row, (byte) 255));
            fail("Expected transport failure");
        } catch (IOException expected) { assertEquals("Cable removed", expected.getMessage()); }
        assertEquals(301, attempted[0]);
    }

    private int indexOf(byte[] bytes, byte[] marker) {
        outer: for (int i = 0; i <= bytes.length - marker.length; i++) {
            for (int j = 0; j < marker.length; j++) if (bytes[i + j] != marker[j]) continue outer;
            return i;
        }
        return -1;
    }
}
