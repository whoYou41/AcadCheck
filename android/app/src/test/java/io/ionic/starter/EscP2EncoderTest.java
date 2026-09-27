package io.ionic.starter;

import org.junit.Test;
import java.io.*;
import java.util.*;
import static org.junit.Assert.*;

public class EscP2EncoderTest {
    // Isolated dots straddle nozzle bands, colour delays, byte boundaries and page edges.
    private static final int[][] DOTS = {
        {0, 0, 255, 0, 0}, {7, 117, 0, 0, 0}, {8, 118, 255, 0, 0},
        {2400, 119, 255, 0, 0}, {2521, 239, 0, 255, 255},
        {2600, 240, 255, 255, 0}, {2601, 241, 255, 0, 255},
        {2700, 3500, 0, 0, 0}, {2972, 4594, 255, 0, 0}, {2975, 4595, 255, 0, 0}
    };
    private byte[] job(boolean blank) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        EscP2Encoder.writeJob(out, (y, rgb) -> {
            assertTrue(y >= 0 && y < 4596);
            Arrays.fill(rgb, (byte) 255);
            if (!blank) for (int[] dot : DOTS) if (dot[1] == y)
                for (int c = 0; c < 3; c++) rgb[dot[0] * 3 + c] = (byte) dot[2 + c];
        });
        return out.toByteArray();
    }
    private int le(byte[] bytes, int p, int count) {
        int value = 0;
        for (int i = 0; i < count; i++) value |= (bytes[p + i] & 255) << (8 * i);
        return value;
    }
    private String key(int color, int x, int y) { return color + ":" + x + ":" + y; }

    @Test public void decodeWireJobRestoresRegisteredColourDotsAndEjectsOnePage() throws Exception {
        byte[] bytes = job(false);
        Map<String, Integer> actual = new HashMap<>();
        int p = 0, x = 0, feed = 0, top = 0, ejects = 0, rasters = 0;
        boolean graphics = false, spacing = false;
        // Skip only the documented packet-mode exit preamble, ending with LF.
        byte[] prefix = new byte[] {0, 0, 0, 27, 1};
        assertArrayEquals(prefix, Arrays.copyOf(bytes, 5));
        p = 5;
        String exit = "@EJL 1284.4\n@EJL     \n";
        assertEquals(exit, new String(bytes, p, exit.length(), "US-ASCII"));
        p += exit.length();
        while (p < bytes.length) {
            int b = bytes[p++] & 255;
            if (b == 12) { ejects++; continue; }
            if (b == 13) { x = 0; continue; }
            assertEquals("Unexpected printable data outside a raster", 27, b);
            int code = bytes[p++] & 255;
            if (code == '@') continue;
            if (code == 'U') { assertEquals(1, bytes[p++]); continue; }
            if (code == '(') {
                int command = bytes[p++] & 255;
                int size = le(bytes, p, 2); p += 2;
                switch (command) {
                    case 'G': assertEquals(1, bytes[p]); graphics = true; break;
                    case 'U': assertArrayEquals(new byte[] {4,4,4,(byte)160,5}, Arrays.copyOfRange(bytes,p,p+size)); break;
                    case 'D': assertArrayEquals(new byte[] {64,56,80,40}, Arrays.copyOfRange(bytes,p,p+size)); spacing = true; break;
                    case 'c': top = le(bytes,p,4); assertEquals(-198,top); break;
                    case 'C': assertEquals(4680,le(bytes,p,4)); break;
                    case 'S': assertEquals(3060,le(bytes,p,4)); assertEquals(4680,le(bytes,p+4,4)); break;
                    case 'v': int advance = le(bytes,p,4); assertTrue(advance >= 0); feed += advance; break;
                    case '$': x = le(bytes,p,4); break;
                    case 'K': case 'i': case 'e': break;
                    default: fail("Unexpected ESC/P2 command " + command);
                }
                p += size;
                continue;
            }
            assertEquals('i',code);
            assertTrue(graphics && spacing);
            int color = bytes[p++] & 255;
            assertEquals(1, bytes[p++]); assertEquals(2, bytes[p++]);
            int stride = le(bytes,p,2); p += 2;
            int lines = le(bytes,p,2); p += 2;
            assertEquals(60,lines); assertEquals(0,stride % 2);
            int headPosition = color == 1 ? 120 : color == 4 ? 0 : 240;
            for (int row = 0; row < lines; row++) {
                ByteArrayOutputStream decoded = new ByteArrayOutputStream();
                while (decoded.size() < stride) {
                    int control = bytes[p++] & 255;
                    if (control < 128) {
                        int count = control + 1;
                        decoded.write(bytes,p,count); p += count;
                    } else {
                        assertNotEquals(128,control);
                        int value = bytes[p++] & 255;
                        for (int r = 0; r < 257 - control; r++) decoded.write(value);
                    }
                }
                assertEquals(stride,decoded.size());
                byte[] dots = decoded.toByteArray();
                for (int i = 0; i < stride * 4; i++) {
                    int level = (dots[i / 4] >> (6 - (i % 4) * 2)) & 3;
                    if (level == 0) continue;
                    assertTrue("Padding nozzle must remain blank",row < 59);
                    String k = key(color,x+i,top+feed+headPosition+row*2);
                    assertNull("A dot must not be printed twice",actual.put(k,level));
                }
            }
            rasters++;
        }
        Map<String,Integer> expected = new HashMap<>();
        for (int[] d : DOTS) {
            int xDot=d[0]+42, yDot=d[1]+42;
            if (d[2]==0 && d[3]==0 && d[4]==0) expected.put(key(0,xDot,yDot),3);
            else {
                if (d[2]==0) expected.put(key(2,xDot,yDot),3);
                if (d[3]==0) expected.put(key(1,xDot,yDot),3);
                if (d[4]==0) expected.put(key(4,xDot,yDot),3);
            }
        }
        assertEquals(expected,actual);
        assertEquals(1,ejects);
        assertTrue(rasters > 0);
        assertTrue("Sparse scores must not stream a blank long-bond raster",bytes.length < 10000);
    }
    @Test public void blankPageHasNoRasterPayload() throws Exception {
        assertTrue(job(true).length < 200);
    }
    @Test public void packBitsHandlesRunsLiteralsAndBoundaryLengths() throws Exception {
        for (int size : new int[] {1,2,127,128,129,724}) {
            for (boolean random : new boolean[] {false,true}) {
                byte[] input = new byte[size];
                if (random) new Random(120).nextBytes(input);
                byte[] encoded = EscP2Encoder.pack(input);
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                for (int p=0;p<encoded.length;) {
                    int c=encoded[p++]&255;
                    if(c<128) {out.write(encoded,p,c+1);p+=c+1;}
                    else {int value=encoded[p++]&255;for(int n=0;n<257-c;n++)out.write(value);}
                }
                assertArrayEquals(input,out.toByteArray());
            }
        }
    }
    @Test public void outputFailureStopsWithoutPageEjectOrReplay() throws Exception {
        final int[] writes = {0};
        try {
            EscP2Encoder.writeJob(new OutputStream() {
                public void write(int b) throws IOException {
                    if (++writes[0] == 20) throw new IOException("Unplugged");
                }
            }, (y,rgb)->fail("Raster should not start after failed initialization"));
            fail("Expected failure");
        } catch (IOException e) { assertEquals("Unplugged",e.getMessage()); }
        assertEquals(20,writes[0]);
    }
}
