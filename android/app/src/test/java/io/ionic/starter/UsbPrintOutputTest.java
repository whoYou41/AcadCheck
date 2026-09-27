package io.ionic.starter;
import org.junit.Test;
import java.io.*;
import java.util.*;
import static org.junit.Assert.*;
public class UsbPrintOutputTest {
    private static class Fake implements UsbPrintOutput.Transport {
        long time; boolean attached = true; int limit = 333, calls, failure = 1;
        int lastTimeout;
        ByteArrayOutputStream received = new ByteArrayOutputStream();
        public long now() { return time; }
        public boolean connected() { return attached; }
        public int send(byte[] b,int offset,int length,int timeout) {
            calls++; lastTimeout = timeout;
            assertTrue(length <= 1024);
            if(failure <= 0) return failure;
            int sent=Math.min(limit,length);
            received.write(b,offset,sent);return sent;
        }
    }
    @Test public void shortTransfersResumeAtConfirmedOffsetWithoutDuplicatingData() throws Exception {
        Fake t=new Fake(); UsbPrintOutput out=new UsbPrintOutput(t);
        byte[] bytes=new byte[5000];new Random(120).nextBytes(bytes);
        out.write(bytes,11,4800);
        assertArrayEquals(Arrays.copyOfRange(bytes,11,4811),t.received.toByteArray());
        assertEquals(4800,out.bytesSent); assertEquals(30000,t.lastTimeout);
    }
    @Test public void negativeAndZeroTransfersAreNotReplayed() throws Exception {
        for(int failure:new int[]{-1,0}) {
            Fake t=new Fake();UsbPrintOutput out=new UsbPrintOutput(t);
            out.write(new byte[25]);t.failure=failure;
            try {out.write(new byte[100]);fail();}
            catch(IOException e) {assertTrue(e.getMessage().contains("still attached"));assertTrue(e.getMessage().contains("25 bytes confirmed"));}
            assertEquals(2,t.calls);assertEquals(25,out.bytesSent);
        }
    }
    @Test public void unpluggedPrinterStopsBeforeSending() throws Exception {
        Fake t=new Fake();UsbPrintOutput out=new UsbPrintOutput(t);t.attached=false;
        try {out.write(1);fail();}catch(IOException e){assertTrue(e.getMessage().contains("disconnected"));}
        assertEquals(0,t.calls);
    }
    @Test public void deadlineBoundsWaitAndStopsWithoutAnotherTransfer() throws Exception {
        Fake t=new Fake();UsbPrintOutput out=new UsbPrintOutput(t);
        t.time=299900;out.write(1);assertEquals(100,t.lastTimeout);
        t.time=300000;
        try {out.write(1);fail();}catch(IOException e){assertTrue(e.getMessage().contains("5 minutes"));}
        assertEquals(1,t.calls);
    }
}
