import { OfflineDataService } from './offline-data.service';

describe('OfflineDataService grading safeguards', () => {
  let service: OfflineDataService;
  let classroom: any;
  let student: any;
  let key: any;

  beforeEach(() => {
    localStorage.clear();
    service = new OfflineDataService();
    classroom = service.createClassroom({ name: 'Offline Class', section: 'A' });
    student = service.createStudent({
      firstName: 'Mobile', lastName: 'Student', studentNumber: 'OFF-001', classroomId: classroom.id,
    });
    key = service.createAnswerKey({
      examTitle: 'Offline Test', subject: 'OMR', classroomId: classroom.id,
      answerKey: 'ABCD', numQuestions: 4, answerKeyDate: '2026-08-23',
    });
  });

  it('refuses to grade incomplete detected answers', () => {
    expect(() => service.saveManualGrade({
      filename: 'incomplete.jpg', classroomId: classroom.id, answerKeyId: key.id,
      studentId: student.id, answers: ['A', '', 'C', 'D'], fingerprint: 'incomplete',
    })).toThrowError(/all 4 questions/);
  });

  it('stores real OMR metrics and prevents a duplicate grade', () => {
    const input = {
      filename: 'sheet.jpg', classroomId: classroom.id, answerKeyId: key.id,
      studentId: student.id, answers: ['A', 'B', 'C', 'D'], confidences: [97, 94, 100, 91],
      fingerprint: 'sha256-sheet', processingMs: 412, overallConfidence: 96,
      anchorMethod: 'jsqr', qrData: 'AC1:1:test',
    };
    const saved = service.saveManualGrade(input);
    expect(saved.omr_confidence).toBe(96);
    expect(saved.processing_time_ms).toBe(412);
    expect(saved.omrResults.map((row: any) => row.confidence)).toEqual([97, 94, 100, 91]);
    expect(() => service.saveManualGrade(input)).toThrowError(/already graded|already has/);

    const secondStudent = service.createStudent({
      firstName: 'Second', lastName: 'Student', studentNumber: 'OFF-002', classroomId: classroom.id,
    });
    service.saveManualGrade({
      ...input, studentId: secondStudent.id, filename: 'second-sheet.jpg', fingerprint: 'sha256-second',
      answers: ['B', 'B', 'C', 'D'], confidences: [95, 96, 97, 98],
    });
    const analytics = service.getQuestionAnalytics('Offline Test', 'Offline Class A');
    expect(analytics.overview.totalResponses).toBe(2);
    expect(analytics.questionStats[0].correctAnswer).toBe('A');
    expect(analytics.questionStats[0].topDistractor).toEqual({ answer: 'B', count: 1, rate: 50 });
    expect(analytics.questionStats[0].answerDistribution).toEqual({ A: 1, B: 1 });
  });
});
