import { of, Subject } from 'rxjs';
import { ScannerPage } from './scanner.page';

describe('Scanner USB print routing', () => {
  let page: any;
  beforeEach(() => {
    page = Object.create(ScannerPage.prototype);
    Object.defineProperty(page, 'isOfflineMode', { value: false, writable: true });
    Object.assign(page, {
      isStandaloneAndroid: true, androidPrintDestination: 'usb',
      usbPrinter: { print: jasmine.createSpy('USB').and.resolveTo({ submitted: true, printerName: 'Epson L3210' }) },
      scanService: {
        getScan: jasmine.createSpy('saved record').and.returnValue(of({
          scan: { examResponse: { total_score: 20 }, omrResults: Array(25) }
        })),
        printScoreOnExamSheet: jasmine.createSpy('server printer')
      },
      showToastMessage: jasmine.createSpy('toast'),
      getAnswersCount: () => 50
    });
  });
  it('prints the selected saved online record locally without calling the server printer', async () => {
    await page.printScoreOnExamSheet(123, true);
    expect(page.scanService.getScan).toHaveBeenCalledOnceWith(123);
    expect(page.usbPrinter.print).toHaveBeenCalledOnceWith('20/25');
    expect(page.scanService.printScoreOnExamSheet).not.toHaveBeenCalled();
  });
  it('routes offline auto-print through the same USB path', async () => {
    page.isOfflineMode = true;
    await page.printOfflineScore({ examResponse: { total_score: 0 }, omrResults: Array(50) });
    expect(page.usbPrinter.print).toHaveBeenCalledOnceWith('0/50');
  });
  it('stops if storage mode changes while the saved record is loading', async () => {
    const response = new Subject<any>();
    page.scanService.getScan.and.returnValue(response);
    const printing = page.printScoreOnExamSheet(123);
    page.isOfflineMode = true;
    response.next({ scan: { examResponse: { total_score: 20 }, omrResults: Array(25) } });
    response.complete();
    await printing;
    expect(page.usbPrinter.print).not.toHaveBeenCalled();
  });
  it('reports USB errors without retrying through the computer', async () => {
    page.usbPrinter.print.and.rejectWith(new Error('Printer disconnected'));
    await page.printScoreOnExamSheet(123, true);
    expect(page.showToastMessage).toHaveBeenCalledWith('Printer disconnected');
    expect(page.scanService.printScoreOnExamSheet).not.toHaveBeenCalled();
  });
});
