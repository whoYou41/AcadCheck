import { Inject, Injectable, InjectionToken } from '@angular/core';
import { Capacitor, registerPlugin } from '@capacitor/core';

export interface DeviceFileExportPlugin {
  saveToDownloads(options: { fileName: string; mimeType: string; base64: string }): Promise<{
    saved: boolean;
    cancelled?: boolean;
    fileName?: string;
    location?: string;
  }>;
}

export const DEVICE_FILE_EXPORT_PLUGIN = new InjectionToken<DeviceFileExportPlugin>(
  'DEVICE_FILE_EXPORT_PLUGIN',
  { providedIn: 'root', factory: () => registerPlugin<DeviceFileExportPlugin>('DeviceFileExport') }
);
export type FileExportResult = 'saved' | 'cancelled' | 'downloaded';

@Injectable({ providedIn: 'root' })
export class DeviceFileExportService {
  constructor(@Inject(DEVICE_FILE_EXPORT_PLUGIN) private readonly nativeExport: DeviceFileExportPlugin) {}

  async save(blob: Blob, fileName: string): Promise<FileExportResult> {
    if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') {
      const result = await this.nativeExport.saveToDownloads({
        fileName,
        mimeType: blob.type || 'application/octet-stream',
        base64: await this.toBase64(blob),
      });
      if (result.cancelled) return 'cancelled';
      if (!result.saved) throw new Error('Android did not confirm that the export was saved.');
      return 'saved';
    }

    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    return 'downloaded';
  }

  private toBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error || new Error('Could not read the export file.'));
      reader.onload = () => {
        const dataUrl = String(reader.result || '');
        const separator = dataUrl.indexOf(',');
        if (separator < 0) {
          reject(new Error('Could not encode the export file.'));
          return;
        }
        resolve(dataUrl.slice(separator + 1));
      };
      reader.readAsDataURL(blob);
    });
  }
}
