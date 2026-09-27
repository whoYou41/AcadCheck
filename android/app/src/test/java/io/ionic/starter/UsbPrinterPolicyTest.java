package io.ionic.starter;

import org.junit.Test;
import java.nio.charset.StandardCharsets;
import static org.junit.Assert.*;

public class UsbPrinterPolicyTest {
    @Test public void requiresEpsonAndExactModel() {
        assertTrue(UsbPrinterPolicy.isL120(0x04b8, "EPSON L120 Series", ""));
        assertTrue(UsbPrinterPolicy.isL120(0x04b8, "", "MFG:EPSON;MDL:L120 Series;CMD:ESCPL2,ESCPR;"));
        assertFalse(UsbPrinterPolicy.isL120(0x04b8, "EPSON L3210 Series", ""));
        assertTrue(UsbPrinterPolicy.isL120(0x04b8, "epson l120 series", ""));
        assertFalse(UsbPrinterPolicy.isL120(0x1234, "L120", ""));
        assertFalse(UsbPrinterPolicy.isL120(0x04b8, "L1200", ""));
        assertFalse(UsbPrinterPolicy.isL120(0x04b8, "L120", "MDL:L3250;"));
        assertFalse(UsbPrinterPolicy.isL120(0x04b8, "", "CMD:L120;"));
    }
    @Test public void deviceIdHonorsLengthAndRejectsTruncation() {
        byte[] text = "MFG:EPSON;MDL:L120 Series;".getBytes(StandardCharsets.US_ASCII);
        byte[] data = new byte[text.length + 8];
        data[1] = (byte) (text.length + 2);
        System.arraycopy(text, 0, data, 2, text.length);
        assertEquals(new String(text, StandardCharsets.US_ASCII), UsbPrinterPolicy.decodeDeviceId(data, data.length));
        assertEquals("", UsbPrinterPolicy.decodeDeviceId(data, 5));
        assertEquals("", UsbPrinterPolicy.decodeDeviceId(data, -1));
    }
    @Test public void rejectsInvalidOrInjectedScore() {
        for (String good : new String[] {"0/50", "49/50", "500/500"}) assertTrue(UsbPrinterPolicy.validScore(good));
        for (String bad : new String[] {"", "51/50", "-1/50", "0/0", "1/501", "1.5/50", "50/50\n", "50/50\033@"})
            assertFalse(bad, UsbPrinterPolicy.validScore(bad));
    }
}
