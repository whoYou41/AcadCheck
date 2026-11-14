package io.ionic.starter;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(OfflineOmrPlugin.class);
        registerPlugin(OfflinePrintPlugin.class);
        registerPlugin(DeviceFileExportPlugin.class);
        registerPlugin(UsbPrinterPlugin.class);
        registerPlugin(LocalCameraPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
