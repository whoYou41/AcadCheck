import { Injectable } from '@angular/core';

export interface OfflineDatabase {
  version: 1;
  counters: Record<string, number>;
  classrooms: any[];
  students: any[];
  answerKeys: any[];
  scans: any[];
  responses: any[];
  activity: any[];
}

export interface OfflineManualGrade {
  filename: string;
  classroomId: number;
  answerKeyId: number;
  studentId: number;
  answers: string[];
  confidences?: number[];
  markedLetters?: string[][];
  verifiedOmr?: boolean;
  fingerprint?: string;
  processingMs?: number;
  overallConfidence?: number;
  anchorMethod?: string;
  qrData?: string;
}

const STORAGE_KEY = 'acadcheck.offline.database.v1';

@Injectable({ providedIn: 'root' })
export class OfflineDataService {
  private emptyDatabase(): OfflineDatabase {
    return {
      version: 1,
      counters: { classrooms: 0, students: 0, answerKeys: 0, scans: 0, responses: 0, activity: 0 },
      classrooms: [],
      students: [],
      answerKeys: [],
      scans: [],
      responses: [],
      activity: [],
    };
  }

  private read(): OfflineDatabase {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (parsed?.version === 1) {
        const normalized = this.normalizeDatabase(parsed as OfflineDatabase);
        if (JSON.stringify(normalized) !== JSON.stringify(parsed)) this.write(normalized);
        return normalized;
      }
    } catch {
      // A corrupt local payload is replaced with a clean, usable database.
    }
    const database = this.emptyDatabase();
    this.write(database);
    return database;
  }

  private normalizeDatabase(value: OfflineDatabase): OfflineDatabase {
    const database: OfflineDatabase = {
      ...this.emptyDatabase(),
      ...value,
      counters: { ...this.emptyDatabase().counters, ...(value.counters || {}) },
      classrooms: Array.isArray(value.classrooms) ? value.classrooms.map(classroom => ({
        ...classroom,
        id: Number(classroom.id),
      })) : [],
      students: Array.isArray(value.students) ? value.students.map(student => {
        const rawClassroomId = student.classroomId ?? student.classroom_id;
        return {
          ...student,
          id: Number(student.id),
          studentNumber: String(student.studentNumber ?? student.student_number ?? ''),
          firstName: String(student.firstName ?? student.first_name ?? ''),
          middleName: String(student.middleName ?? student.middle_name ?? ''),
          lastName: String(student.lastName ?? student.last_name ?? ''),
          classroomId: rawClassroomId == null || rawClassroomId === ''
            ? null
            : Number(rawClassroomId),
          sequentialNumber: Number(student.sequentialNumber ?? student.sequential_number ?? 0),
        };
      }) : [],
      answerKeys: Array.isArray(value.answerKeys) ? value.answerKeys : [],
      scans: Array.isArray(value.scans) ? value.scans : [],
      responses: Array.isArray(value.responses) ? value.responses : [],
      activity: Array.isArray(value.activity) ? value.activity : [],
    };

    // Older offline builds stored every newly created student as sequence 1.
    // Keep the first valid value and deterministically repair duplicates so a
    // handwritten sequence always identifies one student in its classroom.
    const usedByClassroom = new Map<string, Set<number>>();
    for (const student of database.students) {
      const classroomKey = String(student.classroomId ?? 'unassigned');
      const used = usedByClassroom.get(classroomKey) || new Set<number>();
      let sequence = Number(student.sequentialNumber);
      if (!Number.isInteger(sequence) || sequence < 1 || sequence > 60 || used.has(sequence)) {
        sequence = 1;
        while (used.has(sequence) && sequence <= 60) sequence += 1;
      }
      student.sequentialNumber = sequence;
      used.add(sequence);
      usedByClassroom.set(classroomKey, used);
    }
    database.counters['classrooms'] = Math.max(
      Number(database.counters['classrooms'] || 0),
      ...database.classrooms.map(item => Number(item.id || 0))
    );
    database.counters['students'] = Math.max(
      Number(database.counters['students'] || 0),
      ...database.students.map(item => Number(item.id || 0))
    );
    return database;
  }

  private write(database: OfflineDatabase): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(database));
  }

  private clone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value));
  }

  private pearson(left: number[], right: number[]): number | null {
    if (left.length !== right.length || left.length < 5) return null;
    const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
    const leftMean = average(left);
    const rightMean = average(right);
    const leftDeviation = Math.sqrt(average(left.map(value => (value - leftMean) ** 2)));
    const rightDeviation = Math.sqrt(average(right.map(value => (value - rightMean) ** 2)));
    if (!leftDeviation || !rightDeviation) return null;
    const covariance = average(left.map((value, index) => (value - leftMean) * (right[index] - rightMean)));
    return Number(Math.max(-1, Math.min(1, covariance / (leftDeviation * rightDeviation))).toFixed(2));
  }

  private wilsonInterval(successes: number, total: number): { low: number; high: number } {
    if (!total) return { low: 0, high: 100 };
    const z = 1.96;
    const proportion = successes / total;
    const denominator = 1 + z ** 2 / total;
    const center = (proportion + z ** 2 / (2 * total)) / denominator;
    const margin = z * Math.sqrt(proportion * (1 - proportion) / total + z ** 2 / (4 * total ** 2)) / denominator;
    return {
      low: Number((100 * Math.max(0, center - margin)).toFixed(1)),
      high: Number((100 * Math.min(1, center + margin)).toFixed(1)),
    };
  }

  private clusterRiskScores(risks: number[]): Array<'on-track' | 'monitor' | 'review'> {
    if (risks.length < 4) return risks.map(risk => risk >= 60 ? 'review' : risk >= 35 ? 'monitor' : 'on-track');
    const clusterCount = risks.length >= 9 ? 3 : 2;
    const sorted = [...risks].sort((a, b) => a - b);
    let centers = Array.from({ length: clusterCount }, (_, index) =>
      sorted[Math.round(index * (sorted.length - 1) / (clusterCount - 1))]
    );
    let assignments = new Array(risks.length).fill(-1);
    for (let iteration = 0; iteration < 30; iteration += 1) {
      const next = risks.map(risk => centers.reduce((best, center, index) =>
        Math.abs(risk - center) < Math.abs(risk - centers[best]) ? index : best, 0));
      if (next.every((value, index) => value === assignments[index])) break;
      assignments = next;
      centers = centers.map((center, centerIndex) => {
        const members = risks.filter((_, index) => assignments[index] === centerIndex);
        return members.length ? members.reduce((sum, value) => sum + value, 0) / members.length : center;
      });
    }
    const labels = clusterCount === 3 ? ['on-track', 'monitor', 'review'] as const : ['on-track', 'review'] as const;
    const ordered = centers.map((center, index) => ({ center, index })).sort((a, b) => a.center - b.center);
    const labelByCluster = new Map(ordered.map((item, index) => [item.index, labels[index]]));
    return assignments.map(assignment => labelByCluster.get(assignment) || 'monitor');
  }

  private nextId(database: OfflineDatabase, collection: keyof OfflineDatabase): number {
    const name = String(collection);
    database.counters[name] = Number(database.counters[name] || 0) + 1;
    return database.counters[name];
  }

  getClassrooms(): any[] {
    const db = this.read();
    return this.clone(db.classrooms.map(classroom => ({
      ...classroom,
      studentCount: db.students.filter(student => Number(student.classroomId) === Number(classroom.id)).length,
    })));
  }

  getClassroom(id: number): any | null {
    return this.clone(this.read().classrooms.find(item => item.id === id) || null);
  }

  createClassroom(value: any): any {
    const db = this.read();
    const classroom = {
      id: this.nextId(db, 'classrooms'),
      name: String(value.name || '').trim(),
      section: String(value.section || '').trim(),
      teacher: String(value.teacher || 'Offline User').trim(),
      isActive: true,
      studentCount: 0,
    };
    db.classrooms.push(classroom);
    this.write(db);
    return this.clone(classroom);
  }

  updateClassroom(id: number, updates: any): any | null {
    const db = this.read();
    const index = db.classrooms.findIndex(item => item.id === id);
    if (index < 0) return null;
    db.classrooms[index] = { ...db.classrooms[index], ...updates, id };
    this.write(db);
    return this.clone(db.classrooms[index]);
  }

  deleteClassroom(id: number): void {
    const db = this.read();
    db.classrooms = db.classrooms.filter(item => item.id !== id);
    db.students = db.students.map(student => student.classroomId === id
      ? { ...student, classroomId: null }
      : student);
    db.answerKeys = db.answerKeys.map(key => key.classroomId === id
      ? { ...key, classroomId: null, classroomName: '' }
      : key);
    this.write(db);
  }

  getStudents(params?: { classroom_id?: number; student_number?: string; q?: string }): any[] {
    const db = this.read();
    let students = [...db.students];
    if (params?.classroom_id) {
      students = students.filter(item => Number(item.classroomId) === Number(params.classroom_id));
    }
    if (params?.student_number) students = students.filter(item => item.studentNumber === params.student_number);
    if (params?.q) {
      const query = params.q.trim().toLowerCase();
      students = students.filter(item => [item.studentNumber, item.firstName, item.middleName, item.lastName]
        .some(value => String(value || '').toLowerCase().includes(query)));
    }
    return this.clone(students.map(student => {
      const classroom = db.classrooms.find(item => item.id === student.classroomId);
      return {
        ...student,
        classroomName: classroom?.name,
        classroomSection: classroom?.section,
      };
    }));
  }

  getStudent(id: number): any | null {
    return this.clone(this.read().students.find(item => item.id === id) || null);
  }

  createStudent(value: any): any {
    const db = this.read();
    const now = new Date().toISOString();
    const classroomId = value.classroomId == null || value.classroomId === ''
      ? null
      : Number(value.classroomId);
    const requestedSequence = Number(value.sequentialNumber || 0);
    const usedSequences = new Set(db.students
      .filter(item => Number(item.classroomId) === Number(classroomId))
      .map(item => Number(item.sequentialNumber))
      .filter(sequence => Number.isInteger(sequence) && sequence > 0));
    let sequentialNumber = Number.isInteger(requestedSequence) && requestedSequence > 0
      ? requestedSequence
      : 1;
    while (usedSequences.has(sequentialNumber) && sequentialNumber <= 60) sequentialNumber += 1;
    if (sequentialNumber > 60) throw new Error('This classroom already has all 60 student sequence numbers assigned');
    const student = {
      ...value,
      id: this.nextId(db, 'students'),
      middleName: value.middleName || '',
      email: value.email || '',
      phone: value.phone || null,
      classroomId,
      sequentialNumber,
      createdAt: now,
    };
    db.students.push(student);
    this.write(db);
    return this.clone(student);
  }

  updateStudent(id: number, updates: any): any | null {
    const db = this.read();
    const index = db.students.findIndex(item => item.id === id);
    if (index < 0) return null;
    db.students[index] = { ...db.students[index], ...updates, id };
    this.write(db);
    return this.clone(db.students[index]);
  }

  deleteStudent(id: number): void {
    const db = this.read();
    const responseIds = new Set(db.responses.filter(item => item.studentId === id).map(item => item.id));
    db.students = db.students.filter(item => item.id !== id);
    db.responses = db.responses.filter(item => item.studentId !== id);
    db.scans = db.scans.filter(item => !responseIds.has(item.examResponse?.id));
    this.write(db);
  }

  getAnswerKeys(): any[] {
    const db = this.read();
    return this.clone(db.answerKeys.map(key => ({
      ...key,
      totalUsed: db.responses.filter(response => response.answerKeyId === key.id).length,
      classroomName: this.classroomLabel(db, key.classroomId),
    })));
  }

  getAnswerKey(id: number): any | null {
    return this.getAnswerKeys().find(item => item.id === id) || null;
  }

  createAnswerKey(value: any): any {
    const db = this.read();
    const now = new Date().toISOString();
    const key = {
      ...value,
      id: this.nextId(db, 'answerKeys'),
      date: now.slice(0, 10),
      createdAt: now,
      totalUsed: 0,
      isActive: value.isActive !== false,
      qrToken: null,
      printStatus: value.printStatus || 'pending',
      classroomName: this.classroomLabel(db, value.classroomId),
    };
    db.answerKeys.push(key);
    this.write(db);
    return this.clone(key);
  }

  updateAnswerKey(id: number, updates: any): any | null {
    const db = this.read();
    const index = db.answerKeys.findIndex(item => item.id === id);
    if (index < 0) return null;
    db.answerKeys[index] = { ...db.answerKeys[index], ...updates, id };
    this.write(db);
    return this.clone({
      ...db.answerKeys[index],
      classroomName: this.classroomLabel(db, db.answerKeys[index].classroomId),
    });
  }

  deleteAnswerKey(id: number): void {
    const db = this.read();
    db.answerKeys = db.answerKeys.filter(item => item.id !== id);
    this.write(db);
  }

  getScans(filter?: { classroom_id?: number; status?: string; limit?: number; offset?: number }): any[] {
    let scans = [...this.read().scans].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    if (filter?.classroom_id) scans = scans.filter(item => item.classroom_id === filter.classroom_id);
    if (filter?.status) scans = scans.filter(item => item.scan_status === filter.status);
    const offset = Number(filter?.offset || 0);
    const limit = Number(filter?.limit || scans.length);
    return this.clone(scans.slice(offset, offset + limit));
  }

  getScan(id: number): any | null {
    return this.clone(this.read().scans.find(item => item.id === id) || null);
  }

  deleteScan(id: number): void {
    const db = this.read();
    db.scans = db.scans.filter(item => item.id !== id);
    db.responses = db.responses.filter(item => item.examUploadId !== id);
    this.write(db);
  }

  saveManualGrade(input: OfflineManualGrade): any {
    const db = this.read();
    const key = db.answerKeys.find(item => item.id === input.answerKeyId);
    const student = db.students.find(item => item.id === input.studentId);
    if (!key) throw new Error('Select a locally saved answer key');
    if (!student) throw new Error('Select a locally saved student');
    const expected = String(key.answerKey || '').replace(/[^A-D]/gi, '').toUpperCase().split('');
    if (input.answers.length !== expected.length) throw new Error(`Enter all ${expected.length} answers`);
    const verifiedOmr = input.verifiedOmr === true;
    let normalizedAnswers = input.answers.map(answer => String(answer || '').trim().toUpperCase());
    if (normalizedAnswers.some(answer => answer !== '' && !/^[A-D]$/.test(answer))) {
      throw new Error(`Review and select a valid answer for all ${expected.length} questions`);
    }
    if (!verifiedOmr && normalizedAnswers.some(answer => !/^[A-D]$/.test(answer))) {
      throw new Error(`Review and select an answer for all ${expected.length} questions`);
    }
    if (
      verifiedOmr
      && (
        !Array.isArray(input.markedLetters)
        || input.markedLetters.length !== expected.length
        || input.markedLetters.some(row =>
          !Array.isArray(row)
          || row.some(mark => !/^[A-D]$/.test(String(mark || '').trim().toUpperCase()))
        )
      )
    ) {
      throw new Error('The verified OMR row map is incomplete');
    }
    const normalizedMarkedLetters = verifiedOmr
      ? input.markedLetters!.map(row => [...new Set(
          row.map(mark => String(mark || '').trim().toUpperCase())
        )])
      : normalizedAnswers.map(answer => answer ? [answer] : []);
    if (verifiedOmr) {
      // Preserve every detected mark, but multi-mark rows never carry a winning answer into scoring.
      normalizedAnswers = normalizedAnswers.map((answer, index) =>
        normalizedMarkedLetters[index].length > 1 ? '' : answer
      );
    }
    if (verifiedOmr && normalizedAnswers.some((answer, index) => {
      const marks = normalizedMarkedLetters[index];
      return answer
        ? marks.length !== 1 || marks[0] !== answer
        : marks.length === 1;
    })) {
      throw new Error('The verified OMR answers do not match their row states');
    }
    const fingerprint = String(input.fingerprint || '').trim();
    if (fingerprint && db.scans.some(scan => scan.scan_fingerprint === fingerprint)) {
      throw new Error('This exact sheet photo was already graded. Capture a genuinely new answer sheet.');
    }
    if (db.scans.some(scan => scan.answer_key_id === key.id && scan.student_id === student.id && scan.scan_status === 'completed')) {
      throw new Error('This student already has a saved grade for this answer key. Delete the earlier scan before rescanning.');
    }
    const now = new Date().toISOString();
    const scanId = this.nextId(db, 'scans');
    const responseId = this.nextId(db, 'responses');
    const answersJson: Record<number, string> = {};
    const scorePerQuestion: Record<number, number> = {};
    const omrResults = normalizedAnswers.map((answer, index) => {
      const normalized = String(answer || '').toUpperCase();
      const correct = expected[index] || '';
      answersJson[index + 1] = normalized;
      scorePerQuestion[index + 1] = normalized === correct ? 1 : 0;
      return {
        id: index + 1,
        scanned_test_id: scanId,
        question_number: index + 1,
        detected_answer: normalized,
        correct_answer: correct,
        is_correct: normalized === correct,
        confidence: Math.max(0, Math.min(100, Math.round(Number(input.confidences?.[index] || 0)))),
        bubble_region_json: JSON.stringify({
          source: verifiedOmr ? 'device-native-verified' : Number(input.confidences?.[index] || 0) >= 100 ? 'reviewed' : 'offline-omr',
          state: normalizedMarkedLetters[index].length > 1 ? 'multiple' : normalized ? 'single' : 'blank',
        }),
        raw_pixel_intensity: 0,
        marked_letters: normalizedMarkedLetters[index],
      };
    });
    const totalScore = Object.values(scorePerQuestion).reduce((sum, score) => sum + score, 0);
    const percentage = expected.length ? Number((100 * totalScore / expected.length).toFixed(2)) : 0;
    const response = {
      id: responseId,
      studentId: student.id,
      studentNumberScanned: student.studentNumber,
      studentName: `${student.firstName} ${student.lastName}`.trim(),
      firstName: student.firstName,
      middleName: student.middleName || '',
      lastName: student.lastName,
      answersJson,
      scorePerQuestion,
      totalScore,
      percentage,
      isGraded: true,
      gradedBy: -1,
      gradedAt: now,
      examUploadId: scanId,
      answerKeyId: key.id,
      classroomId: input.classroomId,
      createdAt: now,
      examTitle: key.examTitle,
      subject: key.subject,
    };
    const scan = {
      id: scanId,
      filename: input.filename || `offline-scan-${scanId}.jpg`,
      file_path: '',
      file_size: 0,
      mime_type: 'image/jpeg',
      classroom_id: input.classroomId,
      answer_key_id: key.id,
      student_id: student.id,
      student_number_detected: student.studentNumber,
      student_name_detected: `${student.firstName} ${student.lastName}`.trim(),
      sequential_number_detected: student.sequentialNumber,
      answer_key_date_detected: key.answerKeyDate,
      ocr_confidence: Math.max(0, Math.min(100, Math.round(Number(input.overallConfidence || 0)))),
      omr_confidence: Math.max(0, Math.min(100, Math.round(Number(input.overallConfidence || 0)))),
      processing_time_ms: Math.max(0, Math.round(Number(input.processingMs || 0))),
      registration_method: String(input.anchorMethod || 'answer-grid'),
      qr_data: String(input.qrData || ''),
      scan_fingerprint: fingerprint,
      scan_status: 'completed',
      error_message: null,
      processed_at: now,
      created_at: now,
      exam_title: key.examTitle,
      subject: key.subject,
      omrResults,
      examResponse: {
        id: responseId,
        student_id: student.id,
        scanned_test_id: scanId,
        answer_key_id: key.id,
        answers_json: JSON.stringify(answersJson),
        score_per_question_json: JSON.stringify(scorePerQuestion),
        total_score: totalScore,
        percentage,
        is_graded: true,
      },
    };
    db.responses.push(response);
    db.scans.push(scan);
    db.activity.unshift({
      id: this.nextId(db, 'activity'),
      examUploadId: scanId,
      scanned_test_id: scanId,
      action: 'offline_grade_saved',
      description: `Saved ${student.firstName} ${student.lastName}'s ${key.examTitle} score on this device`,
      performedBy: -1,
      performedByName: 'Offline User',
      createdAt: now,
      created_at: now,
    });
    this.write(db);
    return this.clone(scan);
  }

  getResponses(params?: { student_id?: number; classroom_id?: number; limit?: number }): any[] {
    let responses = [...this.read().responses].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    if (params?.student_id) responses = responses.filter(item => item.studentId === params.student_id);
    if (params?.classroom_id) responses = responses.filter(item => item.classroomId === params.classroom_id);
    if (params?.limit) responses = responses.slice(0, params.limit);
    return this.clone(responses);
  }

  updateResponse(id: number, totalScore: number, percentage: number): any | null {
    const db = this.read();
    const response = db.responses.find(item => item.id === id);
    if (!response) return null;
    response.totalScore = Number(totalScore);
    response.percentage = Number(percentage);
    const scan = db.scans.find(item => item.id === response.examUploadId);
    if (scan?.examResponse) {
      scan.examResponse.total_score = Number(totalScore);
      scan.examResponse.percentage = Number(percentage);
    }
    this.write(db);
    return this.clone(response);
  }

  deleteResponse(id: number): void {
    const db = this.read();
    const response = db.responses.find(item => item.id === id);
    db.responses = db.responses.filter(item => item.id !== id);
    if (response) db.scans = db.scans.filter(item => item.id !== response.examUploadId);
    this.write(db);
  }

  getRecords(params?: { classroom_id?: number; exam_id?: number }): any[] {
    const db = this.read();
    const responseByStudent = new Map<number, any>();
    for (const response of db.responses) {
      if (params?.exam_id && response.answerKeyId !== params.exam_id) continue;
      const previous = responseByStudent.get(response.studentId);
      if (!previous || String(response.createdAt) > String(previous.createdAt)) {
        responseByStudent.set(response.studentId, response);
      }
    }
    return this.clone(db.students
      .filter(student => !params?.classroom_id || student.classroomId === params.classroom_id)
      .map(student => {
        const classroom = db.classrooms.find(item => item.id === student.classroomId);
        const response = responseByStudent.get(student.id);
        return {
          classroom_id: student.classroomId,
          classroom_name: classroom?.name || '',
          classroom_section: classroom?.section || '',
          student_id: student.id,
          student_number: student.studentNumber,
          sequential_number: student.sequentialNumber,
          first_name: student.firstName,
          middle_name: student.middleName || '',
          last_name: student.lastName,
          gender: student.gender || null,
          response_id: response?.id || null,
          total_score: response?.totalScore ?? null,
          percentage: response?.percentage ?? null,
          is_graded: response?.isGraded ?? null,
          graded_at: response?.gradedAt || null,
          exam_title: response?.examTitle || null,
          subject: response?.subject || null,
        };
      }));
  }

  getActivity(limit = 10): any[] {
    return this.clone(this.read().activity.slice(0, limit));
  }

  getQuestionAnalytics(examTitle?: string, classroomName?: string): any {
    const db = this.read();
    let responses = db.responses.filter(response => !examTitle || examTitle === 'All Exams' || response.examTitle === examTitle);
    if (classroomName && classroomName !== 'All Classrooms') {
      const classroomIds = db.classrooms.filter(item => item.name === classroomName || this.classroomLabel(db, item.id) === classroomName).map(item => item.id);
      responses = responses.filter(response => classroomIds.includes(response.classroomId));
    }
    const examCount = new Set(responses.map(response => String(response.answerKeyId || 'unassigned'))).size;
    const mixedExamScope = examCount > 1;
    const maxQuestions = Math.max(0, ...responses.map(response => Object.keys(response.scorePerQuestion || {}).length));
    const baseStats = Array.from({ length: maxQuestions }, (_, index) => {
      const questionNumber = index + 1;
      const scores = responses.map(response => Number(response.scorePerQuestion?.[questionNumber] || 0));
      const restScores = responses.map(response => {
        const total = Object.values(response.scorePerQuestion || {}).reduce<number>((sum, value) => sum + Number(value || 0), 0);
        return total - Number(response.scorePerQuestion?.[questionNumber] || 0);
      });
      const keyedAnswers = new Set(responses.map(response => {
        const key = db.answerKeys.find(item => item.id === response.answerKeyId);
        return String(key?.answerKey || '').replace(/[^A-D]/gi, '').toUpperCase()[index] || '';
      }).filter(Boolean));
      const correctAnswer = keyedAnswers.size === 1 ? [...keyedAnswers][0] : '';
      const answerDistribution: Record<string, number> = {};
      responses.forEach(response => {
        const selected = String(response.answersJson?.[questionNumber] || 'Blank').toUpperCase();
        answerDistribution[selected] = Number(answerDistribution[selected] || 0) + 1;
      });
      const correct = scores.reduce((sum, score) => sum + score, 0);
      const attempts = scores.length;
      const correctRate = attempts ? Number((100 * correct / attempts).toFixed(1)) : 0;
      const topDistractor = Object.entries(answerDistribution)
        .filter(([answer]) => answer !== correctAnswer && answer !== 'Blank')
        .sort((a, b) => b[1] - a[1])[0];
      const blankCount = Number(answerDistribution['Blank'] || 0);
      const confidenceValues = responses.map(response => {
        const scan = db.scans.find(item => item.id === response.examUploadId);
        const result = scan?.omrResults?.find((item: any) => Number(item.question_number) === questionNumber);
        return result && Number.isFinite(Number(result.confidence)) ? Number(result.confidence) : null;
      }).filter((value): value is number => value !== null);
      const averageScanConfidence = confidenceValues.length
        ? Number((confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length).toFixed(1))
        : null;
      const lowConfidenceRate = confidenceValues.length
        ? Number((100 * confidenceValues.filter(value => value < 65).length / confidenceValues.length).toFixed(1))
        : 0;
      const wrongRate = Number((100 - correctRate).toFixed(1));
      const discriminationIndex = this.pearson(scores, restScores);
      const topDistractorRate = topDistractor && attempts ? Number((100 * topDistractor[1] / attempts).toFixed(1)) : 0;
      const blankRate = attempts ? Number((100 * blankCount / attempts).toFixed(1)) : 0;
      const distributionValues = Object.values(answerDistribution).filter(value => value > 0);
      const answerEntropy = distributionValues.length > 1
        ? Number((100 * -distributionValues.reduce((sum, value) => {
          const probability = value / attempts;
          return sum + probability * Math.log(probability);
        }, 0) / Math.log(distributionValues.length)).toFixed(1))
        : 0;
      const lowDiscrimination = discriminationIndex === null
        ? 0.35
        : Math.max(0, Math.min(1, (0.2 - discriminationIndex) / 0.5));
      const riskScore = Math.round(100 * Math.min(1,
        0.4 * wrongRate / 100
        + 0.22 * lowDiscrimination
        + 0.12 * topDistractorRate / 100
        + 0.08 * answerEntropy / 100
        + 0.09 * blankRate / 100
        + 0.09 * lowConfidenceRate / 100
      ));
      return {
        questionNumber, attempts, correct, wrong: attempts - correct, correctRate,
        wrongRate,
        correctRateInterval: this.wilsonInterval(correct, attempts),
        discriminationIndex,
        answerEntropy,
        correctAnswer, answerDistribution,
        topDistractor: topDistractor ? {
          answer: topDistractor[0], count: topDistractor[1],
          rate: topDistractorRate,
        } : null,
        blankCount,
        blankRate,
        averageScanConfidence,
        lowConfidenceRate,
        riskScore,
      };
    });
    const clusters = this.clusterRiskScores(baseStats.map(item => item.riskScore));
    const questionStats = baseStats.map((item, index) => {
      let code = 'developing';
      let label = 'Developing understanding';
      if (item.lowConfidenceRate >= 25 && item.averageScanConfidence !== null && item.averageScanConfidence < 65) {
        code = 'scan_quality'; label = 'Verify scan quality';
      } else if (item.attempts >= 8 && item.discriminationIndex !== null && item.discriminationIndex < 0.05 && item.correctRate >= 20 && item.correctRate <= 90) {
        code = 'possible_item_issue'; label = 'Possible item issue';
      } else if ((item.topDistractor?.rate || 0) >= 25 && item.wrongRate >= 30) {
        code = 'shared_misconception'; label = 'Shared misconception';
      } else if (item.correctRate < 50) {
        code = 'learning_gap'; label = 'Learning gap';
      } else if (item.correctRate >= 75) {
        code = 'mastery'; label = 'Mastery';
      }
      let confidence = 100 * (0.15 + 0.55 * Math.min(1, item.attempts / 20)
        + 0.2 * (item.averageScanConfidence === null ? 0.75 : item.averageScanConfidence / 100)
        + 0.1 * (item.discriminationIndex === null ? 0 : 1));
      if (mixedExamScope) confidence *= 0.4;
      confidence = Math.round(Math.max(0, Math.min(100, confidence)));
      let explanation = 'Performance is mixed. Reinforce the concept with a worked example and check understanding again.';
      if (mixedExamScope) explanation = 'Multiple exams are combined. Select one exam for valid item-level interpretation.';
      else if (code === 'scan_quality') explanation = 'Low-confidence marks may be influencing this result. Verify the affected sheets before changing instruction.';
      else if (code === 'possible_item_issue') explanation = 'This item does not separate stronger and weaker overall performers as expected. Check the key, wording, and options.';
      else if (code === 'shared_misconception') explanation = `${item.topDistractor?.rate ?? 0}% selected ${item.topDistractor?.answer || 'the same distractor'}${item.correctAnswer ? ` instead of ${item.correctAnswer}` : ''}, indicating a consistent misconception.`;
      else if (code === 'learning_gap') explanation = 'The model found a broad learning gap. Reteach the underlying concept and use a short follow-up check.';
      else if (code === 'mastery') explanation = 'Most students answered correctly. Use this item as a bridge to a more challenging application.';
      const diagnostic = {
        code, label,
        riskScore: Math.min(100, item.riskScore + (clusters[index] === 'review' ? 5 : 0)),
        confidence,
        evidenceLevel: confidence >= 75 ? 'strong' : confidence >= 50 ? 'moderate' : 'preliminary',
        cluster: clusters[index],
        signals: [
          `${item.correctRate}% correct (95% interval ${item.correctRateInterval.low}–${item.correctRateInterval.high}%)`,
          ...(item.discriminationIndex === null ? [] : [`discrimination ${item.discriminationIndex.toFixed(2)}`]),
        ],
        explanation,
      };
      const { riskScore, ...publicItem } = item;
      return { ...publicItem, diagnostic };
    });
    const ranked = [...questionStats].sort((a, b) => a.correctRate - b.correctRate);
    const priority = [...questionStats].sort((a, b) => b.diagnostic.riskScore - a.diagnostic.riskScore);
    const recommendations = mixedExamScope
      ? ['Select a single exam before acting on item-level AI diagnoses; question numbers from different exams are currently combined.']
      : priority.filter(item => item.diagnostic.code !== 'mastery').slice(0, 5).map(item =>
        item.diagnostic.code === 'possible_item_issue'
          ? `Review question ${item.questionNumber}'s key and wording; its discrimination index is ${item.discriminationIndex?.toFixed(2)}.`
          : item.diagnostic.code === 'shared_misconception'
            ? `Address question ${item.questionNumber}'s distractor ${item.topDistractor?.answer || 'option'}; ${item.topDistractor?.rate ?? 0}% selected it.`
            : item.diagnostic.code === 'scan_quality'
              ? `Verify the scans for question ${item.questionNumber}; ${item.lowConfidenceRate}% were read with low confidence.`
              : `Reteach the concept assessed by question ${item.questionNumber}; only ${item.correctRate}% answered correctly.`
      );
    return {
      overview: {
        totalResponses: responses.length,
        overallCorrectRate: responses.length
          ? Number((responses.reduce((sum, response) => sum + Number(response.percentage || 0), 0) / responses.length).toFixed(1))
          : 0,
        questionsAnalyzed: questionStats.length,
        totalAnswers: responses.length * questionStats.length,
        reliability: responses.length >= 20 ? 'strong' : responses.length >= 8 ? 'moderate' : 'preliminary',
        model: {
          name: 'Offline psychometric clustering',
          version: 'acadcheck-hybrid-diagnostic-v1',
          mode: 'unsupervised-cold-start',
          averageConfidence: questionStats.length
            ? Math.round(questionStats.reduce((sum, item) => sum + item.diagnostic.confidence, 0) / questionStats.length)
            : 0,
          trainedWithTeacherLabels: false,
          examCount,
          scopeWarning: mixedExamScope
            ? 'Select one exam for valid item-level diagnoses; the current scope combines different question sets.'
            : null,
        },
      },
      mostCorrect: questionStats.length ? [...questionStats].sort((a, b) => b.correctRate - a.correctRate)[0] : null,
      mostWrong: ranked[0] || null,
      difficultQuestions: ranked.filter(item => item.correctRate < 60).slice(0, 10),
      recommendations: recommendations.length ? recommendations : ['Collect more graded responses before making an instructional change.'],
      questionStats,
    };
  }

  getDashboardStats(): any {
    const db = this.read();
    const completed = db.scans.filter(item => item.scan_status === 'completed');
    const passed = db.responses.filter(item => Number(item.percentage) >= 75).length;
    const average = db.responses.length
      ? db.responses.reduce((sum, item) => sum + Number(item.percentage || 0), 0) / db.responses.length
      : 0;
    const analytics = this.getQuestionAnalytics();
    return {
      scans: {
        total_scans: db.scans.length,
        completed_scans: completed.length,
        processing_scans: db.scans.filter(item => item.scan_status === 'processing').length,
        pending_scans: db.scans.filter(item => item.scan_status === 'pending').length,
        failed_scans: db.scans.filter(item => item.scan_status === 'failed').length,
      },
      students: { total_students: db.students.length },
      classrooms: { total_classrooms: db.classrooms.length },
      answerKeys: { total_answer_keys: db.answerKeys.length },
      exams: {
        total_exam_responses: db.responses.length,
        passed_count: passed,
        failed_count: db.responses.length - passed,
        average_score: Number(average.toFixed(2)),
      },
      recentActivity: db.activity.slice(0, 10),
      recentScans: db.scans.slice(-10).reverse(),
      recentResponses: db.responses.slice(-10).reverse().map(item => ({
        id: item.id,
        total_score: item.totalScore,
        percentage: item.percentage,
        created_at: item.createdAt,
        student_name: item.studentName,
        exam_title: item.examTitle,
        subject: item.subject,
      })),
      classroomPerformance: db.classrooms.map(classroom => {
        const studentIds = db.students.filter(item => item.classroomId === classroom.id).map(item => item.id);
        const responses = db.responses.filter(item => studentIds.includes(item.studentId));
        const avgScore = responses.length
          ? responses.reduce((sum, item) => sum + Number(item.percentage || 0), 0) / responses.length
          : 0;
        return {
          id: classroom.id,
          name: classroom.name,
          section: classroom.section,
          student_count: studentIds.length,
          avg_score: Number(avgScore.toFixed(2)),
          passed_count: responses.filter(item => Number(item.percentage) >= 75).length,
          failed_count: responses.filter(item => Number(item.percentage) < 75).length,
        };
      }),
      questionerRanking: analytics.questionStats.map((item: any) => ({
        questionNumber: item.questionNumber,
        totalResponses: item.attempts,
        correctCount: item.correct,
        accuracyRate: item.correctRate,
      })),
    };
  }

  exportRecordsCsv(classroomId?: number): Blob {
    const rows = this.getRecords({ classroom_id: classroomId });
    const headers = ['Student Number', 'Sequential Number', 'First Name', 'Middle Initial', 'Last Name', 'Classroom', 'Section', 'Exam', 'Subject', 'Score', 'Percentage'];
    const escape = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const lines = [headers.map(escape).join(','), ...rows.map(row => [
      row.student_number, row.sequential_number, row.first_name, row.middle_name, row.last_name,
      row.classroom_name, row.classroom_section, row.exam_title, row.subject, row.total_score, row.percentage,
    ].map(escape).join(','))];
    return new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  }

  private classroomLabel(db: OfflineDatabase, classroomId: number | null | undefined): string {
    const classroom = db.classrooms.find(item => item.id === classroomId);
    return classroom ? `${classroom.name}${classroom.section ? ` ${classroom.section}` : ''}` : '';
  }
}
