package io.ionic.starter;

import java.io.IOException;
import java.io.OutputStream;

/** Bounded USB submission. A failed transfer may have sent bytes; never replay it. */
public final class UsbPrintOutput extends OutputStream {
    public interface Transport {
        long now();
        boolean connected();
        int send(byte[] data, int offset, int length, int timeoutMs);
    }
    static final int CHUNK_BYTES = 1024, TRANSFER_TIMEOUT_MS = 30000;
    static final long JOB_TIMEOUT_MS = 300000;
    private final Transport transport;
    private final long deadline;
    public long bytesSent;
    public UsbPrintOutput(Transport transport) {
        this.transport = transport;
        this.deadline = transport.now() + JOB_TIMEOUT_MS;
    }
    @Override public void write(int value) throws IOException { write(new byte[] {(byte) value}, 0, 1); }
    @Override public void write(byte[] data, int offset, int length) throws IOException {
        if (offset < 0 || length < 0 || offset > data.length - length) throw new IndexOutOfBoundsException();
        while (length > 0) {
            if (Thread.currentThread().isInterrupted() || !transport.connected())
                throw new IOException("Printer disconnected during submission (" + bytesSent + " bytes sent).");
            long remaining = deadline - transport.now();
            if (remaining <= 0) throw new IOException("Printer submission exceeded 5 minutes (" + bytesSent + " bytes sent).");
            int requested = Math.min(CHUNK_BYTES, length);
            int sent = transport.send(data, offset, requested, (int) Math.min(TRANSFER_TIMEOUT_MS, remaining));
            if (sent <= 0 || sent > requested) {
                String reason = transport.connected()
                    ? "The L120 stopped accepting USB data while still attached. Check paper and printer lights."
                    : "Printer disconnected during submission.";
                throw new IOException(reason + " Last transfer: " + sent + "/" + requested +
                    " bytes; " + bytesSent + " bytes confirmed. Power-cycle the printer before a manual retry.");
            }
            bytesSent += sent; offset += sent; length -= sent;
        }
    }
}
