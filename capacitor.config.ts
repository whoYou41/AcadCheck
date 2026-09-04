import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'io.ionic.starter',
  appName: 'AcadCheck',
  webDir: 'www',
  server: {
    androidScheme: 'https',
    cleartext: true
  },
  android: {
    // Allow the standalone APK to reach the Raspberry Pi's private HTTP URL.
    allowMixedContent: true
  }
};

export default config;
