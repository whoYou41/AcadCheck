import { NgZone } from '@angular/core';
import { UsbPrinterService, savedQuestionResults, savedScoreText } from './usb-printer.service';

describe('USB printing', () => {
  let service: UsbPrinterService;
  let bridge: any;
  beforeEach(() => {
    service = new UsbPrinterService(new NgZone({ enableLongStackTrace: false }));
    Object.defineProperty(service, 'available', { value: true });
    bridge = {
      getStatus: jasmine.createSpy('status').and.resolveTo({ connected: true, devices: [] }),
      printScore: jasmine.createSpy('print').and.resolveTo({
        submitted: true, printerName: 'Epson L3210', bytesSent: 1234, completionConfirmed: false
      }),
      connect: jasmine.createSpy('connect').and.resolveTo({ connected: true }),
      disconnect: jasmine.createSpy('disconnect').and.resolveTo({ connected: false })
    };
    (service as any).bridge = bridge;
  });
  it('uses the saved record question count and preserves zero scores', () => {
    expect(savedScoreText({ examResponse: { total_score: 0 }, omrResults: Array(25) })).toBe('0/25');
    expect(savedScoreText({ grading: { totalScore: 49, totalQuestions: 50 } })).toBe('49/50');
    for (const scan of [{}, { examResponse: { total_score: null }, omrResults: Array(50) },
      { grading: { totalScore: 51, totalQuestions: 50 } }]) {
      expect(() => savedScoreText(scan)).toThrow();
    }
  });
  it('loads per-question correctness from saved OMR rows or score detail', () => {
    expect(savedQuestionResults({ omrResults: [
      { question_number: 1, is_correct: 1 }, { question_number: 2, is_correct: 0 }
    ] })).toEqual([{ questionNumber: 1, isCorrect: true }, { questionNumber: 2, isCorrect: false }]);
    expect(savedQuestionResults({ examResponse: { score_per_question_json: '{"1":1,"2":0}' } }))
      .toEqual([{ questionNumber: 1, isCorrect: true }, { questionNumber: 2, isCorrect: false }]);
  });
  it('reports submission without claiming physical completion', async () => {
    const result = await service.print('49/50');
    expect(bridge.printScore).toHaveBeenCalledOnceWith({ scoreText: '49/50', testPage: false });
    expect(result.completionConfirmed).toBeFalse();
  });
  it('prints only the saved score', async () => {
    await service.print('2/3');
    expect(bridge.printScore).toHaveBeenCalledOnceWith({ scoreText: '2/3', testPage: false });
  });
  it('does not turn a successful submission into failure when status refresh fails', async () => {
    bridge.getStatus.and.rejectWith(new Error('Disconnected after submission'));
    expect((await service.print('49/50')).submitted).toBeTrue();
    expect(bridge.printScore).toHaveBeenCalledTimes(1);
  });
  it('never retries a failed USB job', async () => {
    bridge.printScore.and.rejectWith(new Error('Cable removed'));
    await expectAsync(service.print('49/50')).toBeRejectedWithError('Cable removed');
    expect(bridge.printScore).toHaveBeenCalledTimes(1);
    expect(service.working).toBeFalse();
  });
  it('rejects overlapping print requests', async () => {
    let finish!: (result: any) => void;
    bridge.printScore.and.returnValue(new Promise(resolve => { finish = resolve; }));
    const first = service.print('49/50');
    await expectAsync(service.print('49/50')).toBeRejectedWithError('A printer operation is already running.');
    finish({ submitted: true, printerName: 'Epson L3210' });
    await first;
    expect(bridge.printScore).toHaveBeenCalledTimes(1);
  });
});
