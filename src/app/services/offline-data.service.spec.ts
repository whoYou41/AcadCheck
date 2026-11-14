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

  it('stores verified blanks and multiple marks while scoring them as zero', () => {
    const saved = service.saveManualGrade({
      filename: 'verified-special-rows.jpg',
      classroomId: classroom.id,
      answerKeyId: key.id,
      studentId: student.id,
      answers: ['A', '', '', 'D'],
      markedLetters: [['A'], [], ['B', 'C'], ['D']],
      verifiedOmr: true,
      confidences: [98, 92, 91, 97],
      fingerprint: 'verified-special-rows',
      processingMs: 510,
      overallConfidence: 95,
      anchorMethod: 'answer-grid',
    });

    expect(saved.examResponse.total_score).toBe(2);
    expect(saved.omrResults.map((row: any) => row.detected_answer)).toEqual(['A', '', '', 'D']);
    expect(saved.omrResults.map((row: any) => row.marked_letters)).toEqual([
      ['A'], [], ['B', 'C'], ['D'],
    ]);
    expect(saved.omrResults.map((row: any) => JSON.parse(row.bubble_region_json).state)).toEqual([
      'single', 'blank', 'multiple', 'single',
    ]);
  });

  it('scores a row with a selected answer plus two detected marks as zero', () => {
    const saved = service.saveManualGrade({
      filename: 'double-mark.jpg', classroomId: classroom.id, answerKeyId: key.id,
      studentId: student.id, answers: ['A', 'B', 'C', 'D'],
      markedLetters: [['A'], ['B', 'D'], ['C'], ['D']], verifiedOmr: true,
      fingerprint: 'double-mark',
    });
    expect(saved.examResponse.total_score).toBe(3);
    expect(saved.omrResults[1].detected_answer).toBe('');
    expect(saved.omrResults[1].marked_letters).toEqual(['B', 'D']);
    expect(JSON.parse(saved.omrResults[1].bubble_region_json).state).toBe('multiple');
    expect(JSON.parse(saved.examResponse.score_per_question_json)['2']).toBe(0);
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
    expect(analytics.overview.model.version).toBe('acadcheck-hybrid-diagnostic-v1');
    expect(analytics.overview.model.mode).toBe('unsupervised-cold-start');
    expect(analytics.questionStats[0].correctRateInterval).toEqual(jasmine.objectContaining({ low: jasmine.any(Number), high: jasmine.any(Number) }));
    expect(analytics.questionStats[0].diagnostic).toEqual(jasmine.objectContaining({
      riskScore: jasmine.any(Number),
      confidence: jasmine.any(Number),
      explanation: jasmine.any(String),
    }));
  });

  it('assigns unique sequential numbers to new students in each offline classroom', () => {
    expect(student.sequentialNumber).toBe(1);
    const second = service.createStudent({
      firstName: 'Second', lastName: 'Student', studentNumber: 'OFF-002',
      classroomId: classroom.id, sequentialNumber: 0,
    });
    const third = service.createStudent({
      firstName: 'Third', lastName: 'Student', studentNumber: 'OFF-003',
      classroomId: classroom.id, sequentialNumber: 0,
    });
    expect([student, second, third].map(item => item.sequentialNumber)).toEqual([1, 2, 3]);
    expect(service.getStudents({ classroom_id: classroom.id }).length).toBe(3);
  });

  it('restores saved offline work when the application service starts again', () => {
    const restored = new OfflineDataService();

    expect(restored.getClassrooms().map(item => item.id)).toContain(classroom.id);
    expect(restored.getStudents({ classroom_id: classroom.id }).map(item => item.id)).toContain(student.id);
    expect(restored.getAnswerKeys().map(item => item.id)).toContain(key.id);
  });

  it('migrates legacy student fields and repairs duplicate offline sequences', () => {
    localStorage.setItem('acadcheck.offline.database.v1', JSON.stringify({
      version: 1,
      counters: {},
      classrooms: [{ id: '7', name: 'Legacy', section: 'A' }],
      students: [
        { id: '10', student_number: 'L-1', first_name: 'One', last_name: 'Student', classroom_id: '7', sequential_number: 1 },
        { id: '11', student_number: 'L-2', first_name: 'Two', last_name: 'Student', classroom_id: '7', sequential_number: 1 },
      ],
      answerKeys: [], scans: [], responses: [], activity: [],
    }));

    const migrated = service.getStudents({ classroom_id: 7 });
    expect(migrated.map(item => item.sequentialNumber)).toEqual([1, 2]);
    expect(migrated.map(item => item.firstName)).toEqual(['One', 'Two']);
    expect(migrated.every(item => item.classroomId === 7)).toBeTrue();
  });
});
