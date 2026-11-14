import { Capacitor } from '@capacitor/core';
import { DeviceFileExportPlugin, DeviceFileExportService } from './device-file-export.service';

describe('DeviceFileExportService', () => {
  let plugin: jasmine.SpyObj<DeviceFileExportPlugin>;
  let service: DeviceFileExportService;

  beforeEach(() => {
    plugin = jasmine.createSpyObj<DeviceFileExportPlugin>('DeviceFileExportPlugin', ['saveToDownloads']);
    plugin.saveToDownloads.and.resolveTo({ saved: true, fileName: 'records.xlsx', location: 'Download/AcadCheck' });
    service = new DeviceFileExportService(plugin);
  });

  it('writes Android exports through the native Downloads bridge and sends the original bytes', async () => {
    spyOn(Capacitor, 'isNativePlatform').and.returnValue(true);
    spyOn(Capacitor, 'getPlatform').and.returnValue('android');

    const result = await service.save(new Blob(['grade data'], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }), 'records.xlsx');

    expect(result).toBe('saved');
    expect(plugin.saveToDownloads).toHaveBeenCalledWith(jasmine.objectContaining({
      fileName: 'records.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      base64: btoa('grade data'),
    }));
  });

  it('reports cancellation without claiming that the export was saved', async () => {
    spyOn(Capacitor, 'isNativePlatform').and.returnValue(true);
    spyOn(Capacitor, 'getPlatform').and.returnValue('android');
    plugin.saveToDownloads.and.resolveTo({ saved: false, cancelled: true });

    await expectAsync(service.save(new Blob(['x']), 'records.csv')).toBeResolvedTo('cancelled');
  });
});
