import { of, Subject } from 'rxjs';
import { ScannerPage } from './scanner.page';

const outcomes = (count: number): Array<{ question_number: number; is_correct: boolean }> =>
  Array.from({ length: count }, (_, index) => ({ question_number: index + 1, is_correct: index % 2 === 0 }));

describe('Scanner USB print routing', () => {
  let page: any;
  beforeEach(() => {
    page = Object.create(ScannerPage.prototype);
    Object.defineProperty(page, 'isOfflineMode', { value: false, writable: true });
    Object.assign(page, {
      isStandaloneAndroid: true, androidPrintDestination: 'usb',
      usbPrinter: { print: jasmine.createSpy('USB').and.resolveTo({ submitted: true, printerName: 'Epson L120' }) },
      scanService: {
        getScan: jasmine.createSpy('saved record').and.returnValue(of({
          scan: { examResponse: { total_score: 20 }, omrResults: outcomes(25) }
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
    expect(page.usbPrinter.print).toHaveBeenCalledOnceWith('20/25', false, outcomes(25).map(row => ({ questionNumber: row.question_number, isCorrect: row.is_correct })));
    expect(page.scanService.printScoreOnExamSheet).not.toHaveBeenCalled();
  });
  for (const offline of [false, true]) {
    it('auto-prints over USB despite a saved dialog destination, offline=' + offline, async () => {
      page.isOfflineMode = offline;
      page.autoPrintEnabled = true;
      page.androidPrintDestination = 'system';
      if (offline) await page.printOfflineScore({ examResponse: { total_score: 20 }, omrResults: outcomes(25) });
      else await page.printScoreOnExamSheet(123, true);
      expect(page.usbPrinter.print).toHaveBeenCalledOnceWith('20/25', false, outcomes(25).map(row => ({ questionNumber: row.question_number, isCorrect: row.is_correct })));
      expect(page.scanService.printScoreOnExamSheet).not.toHaveBeenCalled();
    });
  }
  it('reports disconnected USB during auto-print without a dialog fallback', async () => {
    page.isOfflineMode = true;
    page.autoPrintEnabled = true;
    page.androidPrintDestination = 'system';
    page.usbPrinter.print.and.rejectWith(new Error('Printer disconnected'));
    await page.printOfflineScore({ examResponse: { total_score: 20 }, omrResults: outcomes(25) });
    expect(page.usbPrinter.print).toHaveBeenCalledOnceWith('20/25', false, outcomes(25).map(row => ({ questionNumber: row.question_number, isCorrect: row.is_correct })));
    expect(page.showToastMessage).toHaveBeenCalledWith('Printer disconnected');
  });
  it('does not fall back to a browser dialog when offline auto-print fails', async () => {
    page.isStandaloneAndroid = false;
    page.isOfflineMode = true;
    page.autoPrintEnabled = true;
    page.http = { post: () => of({ success: false }) };
    page.printScoreInFrame = jasmine.createSpy('browser dialog');
    await page.printOfflineScore({ examResponse: { total_score: 20 }, omrResults: outcomes(25) });
    expect(page.printScoreInFrame).not.toHaveBeenCalled();
    expect(page.showToastMessage).toHaveBeenCalledWith('Auto Print failed: the local printer did not accept the print job.');
  });
  it('routes offline auto-print through the same USB path', async () => {
    page.isOfflineMode = true;
    await page.printOfflineScore({ examResponse: { total_score: 0 }, omrResults: outcomes(50) });
    expect(page.usbPrinter.print).toHaveBeenCalledOnceWith('0/50', false, outcomes(50).map(row => ({ questionNumber: row.question_number, isCorrect: row.is_correct })));
  });
  it('stops if storage mode changes while the saved record is loading', async () => {
    const response = new Subject<any>();
    page.scanService.getScan.and.returnValue(response);
    const printing = page.printScoreOnExamSheet(123);
    page.isOfflineMode = true;
    response.next({ scan: { examResponse: { total_score: 20 }, omrResults: outcomes(25) } });
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
