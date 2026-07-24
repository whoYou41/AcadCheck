import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'io.ionic.starter',
  appName: 'AcadCheck',
  webDir: 'www',
  server: {
    url: 'http://localhost',
    cleartext: true
  }
};

export default config;
