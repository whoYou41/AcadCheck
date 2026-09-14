import { PAGE_TOURS } from './page-guidance.tours';

describe('page product tours', () => {
  it('covers every primary workspace', () => {
    expect(Object.keys(PAGE_TOURS).sort()).toEqual([
      'admin', 'answer-key', 'dashboard', 'profile', 'records', 'results', 'scanner', 'students'
    ]);
    Object.values(PAGE_TOURS).forEach(tour => {
      expect(tour.steps.length).toBeGreaterThan(3);
      tour.steps.forEach(step => {
        expect(step.target).toBeTruthy();
        expect(step.action).toBeTruthy();
      });
    });
  });

  it('explains the Results algorithm and its limits', () => {
    const copy = PAGE_TOURS['results'].steps
      .map(step => [step.description, step.detail || ''].join(' '))
      .join(' ');
    ['Wilson 95%', 'discrimination', 'risk score', 'supervised', 'scan confidence', 'does not read'].forEach(term => {
      expect(copy).toContain(term);
    });
  });

  it('describes the scanner as an offline stable-confirmation workflow', () => {
    const copy = PAGE_TOURS['scanner'].steps.map(step => step.description).join(' ');
    expect(copy).toContain('without an internet connection');
    expect(copy).toContain('matching full-sheet readings');
    expect(copy).toContain('student sequence');
  });
});
