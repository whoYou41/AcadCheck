package io.ionic.starter;

import org.junit.Test;
import static org.junit.Assert.*;

public class CameraEndpointPolicyTest {
    @Test public void acceptsLocalCameraEndpoints() throws Exception {
        for (String host : new String[]{"192.168.254.104", "10.0.0.3", "172.16.1.2", "acadacam.local", "acadcam"}) {
            assertEquals(host, CameraEndpointPolicy.validate("http://" + host + ":5000/capture?quality=86", "GET").getHost());
        }
        CameraEndpointPolicy.validate("http://192.168.1.2:5000/restart-camera", "POST");
    }
    @Test public void rejectsPublicCredentialsAndUnrelatedPaths() {
        for (String value : new String[]{"http://example.com/capture", "http://8.8.8.8/status", "http://192.168.1.999/status",
            "http://user:pass@192.168.1.2/capture", "http://192.168.1.2/admin", "ftp://192.168.1.2/capture"}) {
            assertThrows(Exception.class, () -> CameraEndpointPolicy.validate(value, "GET"));
        }
        assertThrows(Exception.class, () -> CameraEndpointPolicy.validate("http://192.168.1.2/capture", "POST"));
    }
    @Test public void rejectsHtmlAndEmptySuccessResponsesInsteadOfShowingABlankPreview() throws Exception {
        assertThrows(Exception.class, () -> CameraEndpointPolicy.imageType(new byte[0]));
        assertThrows(Exception.class, () -> CameraEndpointPolicy.imageType("<html>Sign in</html>".getBytes()));
        assertEquals("image/jpeg", CameraEndpointPolicy.imageType(new byte[]{(byte)255, (byte)216, (byte)255, (byte)224}));
        assertEquals("image/png", CameraEndpointPolicy.imageType(new byte[]{(byte)137,80,78,71,13,10,26,10}));
    }
}
