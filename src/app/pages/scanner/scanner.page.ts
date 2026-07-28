import { Component, OnInit, OnDestroy, ViewChild } from '@angular/core';
import { AlertController } from '@ionic/angular';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { timeout } from 'rxjs/operators';
import {
  IonContent, IonHeader, IonToolbar, IonTitle, IonButtons, IonBackButton, IonGrid,
  IonRow, IonCol, IonCard, IonCardHeader, IonCardTitle, IonCardSubtitle, IonCardContent,
  IonButton, IonIcon, IonSelect, IonSelectOption, IonList, IonItem, IonLabel,
  IonAvatar, IonBadge, IonMenuButton, IonSearchbar, IonToast, IonNote,
  IonProgressBar, IonText, IonAccordionGroup, IonAccordion, IonSegment, IonSegmentButton,
  IonRefresher, IonRefresherContent, IonChip, IonInput, IonToggle
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  cameraOutline, flashOutline, schoolOutline, keyOutline, peopleOutline,
  personOutline, addCircleOutline, checkmarkCircleOutline, alertCircleOutline,
  timeOutline, closeCircleOutline, videocam, cloudUploadOutline, refreshOutline,
  scanOutline, documentTextOutline, bookOutline, idCardOutline, trophyOutline,
  listOutline, eyeOutline, calculatorOutline, imageOutline, radioButtonOn,
  informationCircleOutline, chevronForwardOutline, warningOutline,
  calendarOutline, printOutline, qrCodeOutline
} from 'ionicons/icons';
import { AnswerKeyService } from '../../services/answer-key.service';
import { ScanService } from '../../services/scan.service';
import { AuthService } from '../../services/auth.service';
import { ClassroomService } from '../../services/classroom.service';
import { StudentService } from '../../services/student.service';

interface ScanStats {
  totalScans: number;
  completedScans: number;
  pendingScans: number;
  failedScans: number;
}

@Component({
  selector: 'app-scanner',
  templateUrl: './scanner.page.html',
  styleUrls: ['./scanner.page.scss'],
  standalone: true,
  imports: [
    CommonModule, FormsModule, IonContent, IonHeader, IonToolbar, IonTitle, IonButtons,
    IonBackButton, IonMenuButton, IonGrid, IonRow, IonCol, IonCard, IonCardHeader,
    IonCardTitle, IonCardSubtitle, IonCardContent, IonButton, IonIcon, IonSelect, IonSelectOption,
    IonList, IonItem, IonLabel, IonAvatar, IonBadge, IonMenuButton, IonSearchbar, IonToast, IonNote,
    IonProgressBar, IonText, IonAccordionGroup, IonAccordion, IonSegment, IonSegmentButton,
    IonRefresher, IonRefresherContent, IonChip, IonInput, IonToggle
  ],
})
export class ScannerPage implements OnInit, OnDestroy {
  scanMode: 'camera' | 'upload' = 'camera';

       // Camera (external camera server)
  isScannerActive: boolean = false;
  espCamUrl: string = localStorage.getItem('scanner.cameraUrl') || 'http://192.168.254.104:5000';
  espCamStreamUrl: string = '';
  espCamCaptureUrl: string = '';
  isDiscoveringCamera: boolean = false;
  capturedImage: string | null = null;
  streamFrameBlobUrl: string | null = null;
  streamPollTimer: any = null;
  streamErrorCount: number = 0;
  MAX_STREAM_ERRORS = 5;
  POLL_INTERVAL_MS = 350;
  autoScanEnabled: boolean = true;
  autoRecordEnabled: boolean = false;
  autoPrintEnabled: boolean = false;
  detectionActive: boolean = false;
  autoDetectionInFlight: boolean = false;
  autoCaptureTimer: any = null;
  lastProcessedTime: number = 0;
  DEBOUNCE_MS = 450;
  DETECTION_INTERVAL_MS = 450;
  AUTO_SCAN_COOLDOWN_MS = 1500;
  autoScanCooldownUntil: number = 0;
  autoScanCooldownSeconds: number = 0;
  autoScanCooldownTimer: any = null;
  private autoCapturedScan: boolean = false;
  REQUIRED_STABLE_FRAMES = 2;
  stableDetectionSignature: string = '';
  stableDetectionFrames: number = 0;
  lastCapturedSignature: string = '';
  pendingCapturedSignature: string = '';
  lastCapturedFingerprint: string = '';
  pendingCapturedFingerprint: string = '';
  private awaitingSheetRemoval: boolean = false;
  private noSheetFrames: number = 0;
  private readonly REQUIRED_NO_SHEET_FRAMES = 2;
  private trackingSessionId: string | null = null;
  private trackingFrameSequence: number = 0;
  private trackingAnswerKeyIdentity: string = '';
  streamError: boolean = false;
  isPolling: boolean = false;
  streamAbortController: AbortController | null = null;

  // Live OMR overlay / quality gate
  liveDetection: any = null;
  liveConfidence: number = 0;
  liveConfidenceColor: string = 'danger';
  liveDetectionStatus: 'idle' | 'scanning' | 'accept' | 'reject' | 'processing' = 'idle';
  liveQualityMessage: string = '';
  liveAnswerPreview: { q: number; answer: string; confidence: number }[] = [];
  recentLiveQualities: Array<{ confidence: number; color: string; message: string; selected: string[]; detectedCount: number }> = [];
  MAX_LIVE_QUALITY_HISTORY = 6;

  FRAME_CONFIDENCE_WARN = 55;
  FRAME_CONFIDENCE_ACCEPT = 90;
  FRAME_DETECTED_REQUIRE = 1;

  // Live OMR overlay diagnostics
  liveDebugMessage: string = '';

  // Reference data
  answerKeys: any[] = [];
  classrooms: any[] = [];
  students: any[] = [];
  studentsLoaded: boolean = false;

  // Selections
  selectedAnswerKeyId: number | null = null;
  selectedClassroomId: number | null = null;
  selectedStudentId: number | null = null;
  private autoSelectedStudentId: number | null = null;

  // Processing
  isProcessing: boolean = false;
  uploadProgress = 0;

  // Training / Calibration
  isCalibrating: boolean = false;
  calibrationImage: string | null = null;
  calibrationSequenceRegion: any = null;
  calibrationResults: any = null;

  // Exam sheet detection
  examSheetDetection: any = null;
  examSheetConfidence: number = 0;
  examSheetConfidenceColor: string = 'danger';
  examSheetRecommendation: string = '';

  // Current result
  currentScan: any = null;
  lastScanFailure: any = null;

  // History & Stats
  scanHistory: any[] = [];
  stats: ScanStats = { totalScans: 0, completedScans: 0, pendingScans: 0, failedScans: 0 };

  // Toast
  toastMessage: string = '';
  showToast: boolean = false;

  // File input
  @ViewChild('fileInput') fileInput!: any;

  // File upload
  selectedFile: File | null = null;
  previewUrl: string | null = null;
  isDragOver = false;

    constructor(
    private answerKeyService: AnswerKeyService,
    private scanService: ScanService,
    private authService: AuthService,
    private classroomService: ClassroomService,
    private studentService: StudentService,
    private http: HttpClient,
    private alertCtrl: AlertController
    ) {
    addIcons({
    cameraOutline, flashOutline, schoolOutline, keyOutline, peopleOutline,
    personOutline, addCircleOutline, checkmarkCircleOutline, alertCircleOutline,
    timeOutline, closeCircleOutline, videocam, cloudUploadOutline, refreshOutline,
    scanOutline, documentTextOutline, bookOutline, idCardOutline, trophyOutline,
    listOutline, eyeOutline, calculatorOutline, imageOutline, radioButtonOn,
    informationCircleOutline, chevronForwardOutline, warningOutline,
    calendarOutline, printOutline, qrCodeOutline
    });
    }

  ngOnInit() {
    this.autoRecordEnabled = localStorage.getItem('scanner.autoRecord') === 'true';
    this.autoPrintEnabled = localStorage.getItem('scanner.autoPrint') === 'true';
    if (this.autoPrintEnabled) this.autoRecordEnabled = true;
    this.loadReferenceData();
    this.loadScanHistory();
    this.loadStats();
    this.updateCameraUrls();
    this.discoverAcadcam(true);
  }

  updateCameraUrls() {
    // Ensure URL doesn't end with slash for proper concatenation.
    const baseUrl = this.espCamUrl.trim().replace(/\/+$/, '');
    this.espCamUrl = baseUrl;
    this.espCamStreamUrl = baseUrl ? `${baseUrl}/stream` : '';
    this.espCamCaptureUrl = baseUrl ? `${baseUrl}/capture` : '';
    if (baseUrl) localStorage.setItem('scanner.cameraUrl', baseUrl);
  }

  discoverAcadcam(silent = false) {
    if (this.isDiscoveringCamera) return;
    this.isDiscoveringCamera = true;
    if (!silent) this.showToastMessage('Looking for acadacam on the local network...');

    this.scanService.discoverAcadcam().pipe(timeout(10000)).subscribe({
      next: (result) => {
        this.isDiscoveringCamera = false;
        if (!result?.success || !result.cameraUrl) return;
        this.espCamUrl = result.cameraUrl;
        this.updateCameraUrls();
        this.streamError = false;
        this.showToastMessage(`acadacam detected at ${result.ipAddress}`);
      },
      error: (error) => {
        this.isDiscoveringCamera = false;
        console.warn('Automatic acadcam discovery failed:', error);
        if (!silent) {
          this.showToastMessage('acadacam was not found. Check that this device and the camera are on the same network.');
        }
      }
    });
  }

  recordLiveFrame(
    confidence: number,
    detectedCount: number,
    totalCount: number,
    answers: string[] = [],
    completeRowMap = false,
    acceptedByQualityGate = false
  ) {
    this.liveConfidence = Math.round(confidence * 10) / 10;

    if (confidence >= this.FRAME_CONFIDENCE_ACCEPT) {
      this.liveConfidenceColor = 'success';
      this.liveDetectionStatus = 'accept';
    } else if (confidence >= this.FRAME_CONFIDENCE_WARN) {
      this.liveConfidenceColor = 'warning';
      this.liveDetectionStatus = 'scanning';
    } else {
      this.liveConfidenceColor = 'danger';
      this.liveDetectionStatus = 'reject';
    }

    const filled = (answers || []).filter((a: string) => a && a.trim && a.trim() !== '').length || detectedCount;
    const blankCount = completeRowMap ? Math.max(0, totalCount - filled) : 0;
    let qualityMessage = `Detected ${filled}/${totalCount} answers`;
    if (acceptedByQualityGate && completeRowMap) {
      this.liveConfidenceColor = 'success';
      this.liveDetectionStatus = 'accept';
      qualityMessage = blankCount > 0
        ? `Ready — ${blankCount} blank answer${blankCount === 1 ? '' : 's'} will score zero`
        : 'Ready to capture';
    } else if (detectedCount === 0) qualityMessage = 'No answers detected';
    else if (detectedCount / Math.max(1, totalCount) < this.FRAME_DETECTED_REQUIRE) qualityMessage = 'Incomplete detection';
    else if (confidence < this.FRAME_CONFIDENCE_WARN) qualityMessage = 'Low confidence';
    else if (confidence < this.FRAME_CONFIDENCE_ACCEPT) qualityMessage = 'Scanning...';
    else qualityMessage = 'Ready to capture';

    this.liveQualityMessage = qualityMessage;

    this.liveAnswerPreview = (answers || [])
      .map((answer, index) => ({ q: index + 1, answer, confidence }))
      .slice(0, Math.min(totalCount || answers.length, 30));

    this.recentLiveQualities.unshift({
      confidence: Math.round(confidence * 10) / 10,
      color: this.liveConfidenceColor,
      message: qualityMessage,
      selected: answers.slice(0, 8),
      detectedCount: filled,
    });
    if (this.recentLiveQualities.length > this.MAX_LIVE_QUALITY_HISTORY) {
      this.recentLiveQualities = this.recentLiveQualities.slice(0, this.MAX_LIVE_QUALITY_HISTORY);
    }
  }
    
    testStreamConnection() {
        if (!this.espCamUrl) {
            this.showToastMessage('Please enter camera URL first');
            return;
        }

        this.showToastMessage('Testing camera connection...');
        
        // First, try to get a single frame from /capture endpoint (more reliable)
        const captureUrl = this.espCamCaptureUrl || `${this.espCamUrl.replace(/\/+$/, '')}/capture`;
        
        this.http.get(captureUrl, { responseType: 'blob' }).pipe(
            timeout(3000)  // 3 second timeout
        ).subscribe({
            next: (blob) => {
                if (blob.size > 0) {
                    console.log('✅ Camera connection successful (capture test)');
                    this.streamError = false;
                    this.showToastMessage('✅ Camera connected and responding!');
                    // Now update stream URL with fresh timestamp
                    this.updateCameraUrls();
                } else {
                    throw new Error('Empty response from camera');
                }
            },
            error: (err) => {
                console.error('Capture test failed:', err);
                
                // Fallback: Test /status endpoint
                const statusUrl = `${this.espCamUrl.replace(/\/+$/, '')}/status`;
                this.http.get(statusUrl).pipe(
                    timeout(3000)
                ).subscribe({
                    next: (response: any) => {
                        console.log('✅ Camera connection successful (status test)');
                        this.streamError = false;
                        this.showToastMessage('✅ Camera is online! (status verified)');
                        this.updateCameraUrls();
                    },
                    error: (statusErr) => {
                        console.error('Status test also failed:', statusErr);
                        
                        // Final fallback: Try root endpoint
                        this.http.get(this.espCamUrl).pipe(
                            timeout(3000)
                        ).subscribe({
                            next: () => {
                                console.log('✅ Camera connection successful (root test)');
                                this.streamError = false;
                                this.showToastMessage('✅ Camera detected! Starting stream...');
                                this.updateCameraUrls();
                            },
                            error: () => {
                                console.error('All connection tests failed');
                                this.streamError = true;
                                this.showToastMessage('❌ Cannot connect to camera. Check URL, firewall, and network.');
                            }
                        });
                    }
                });
            }
        });
    }

  ngOnDestroy() {
    this.stopStreamPoll();
    this.stopAutoDetection();
    this.clearAutoScanCooldown();
    this.cleanupStream();
    this.endTrackingSession();
    this.isProcessing = false;
  }

  loadReferenceData() {
    this.answerKeyService.getAnswerKeys().subscribe({
      next: (keys) => {
        this.answerKeys = keys;
      },
      error: (err) => console.error('Failed to load answer keys:', err)
    });

    this.classroomService.getClassrooms().subscribe({
      next: (classrooms) => {
        this.classrooms = classrooms;
      },
      error: (err: any) => console.error('Failed to load classrooms:', err)
    });
  }

  onClassroomChange(): Promise<void> {
    this.selectedStudentId = null;
    this.autoSelectedStudentId = null;
    this.students = [];
    this.studentsLoaded = false;
    if (!this.selectedClassroomId) {
      this.studentsLoaded = true;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.studentService.getStudentsByClassroom(this.selectedClassroomId!).subscribe({
        next: (students: any[]) => {
          this.students = students;
          this.studentsLoaded = true;
          resolve();
        },
        error: (err) => {
          console.error('Failed to load students:', err);
          this.showToastMessage('Failed to load students for selected classroom');
          this.studentsLoaded = true;
          resolve();
        }
      });
    });
  }

  loadScanHistory() {
    this.scanService.getScans({ limit: 10 }).subscribe({
      next: (response: any) => {
        this.scanHistory = response.scans || [];
      },
      error: (err) => console.error('Failed to load scan history:', err)
    });
  }

  loadStats() {
    this.scanService.getScans({ limit: 100 }).subscribe({
      next: (response: any) => {
        const scans = response.scans || [];
        this.stats = {
          totalScans: scans.length,
          completedScans: scans.filter((s: any) => s.scan_status === 'completed').length,
          pendingScans: scans.filter((s: any) => s.scan_status === 'pending').length,
          failedScans: scans.filter((s: any) => s.scan_status === 'failed').length,
        };
      },
      error: (err) => {
        console.error('Failed to load stats:', err);
        this.stats = { totalScans: 0, completedScans: 0, pendingScans: 0, failedScans: 0 };
      }
    });
  }

   async autoPickAnswerKeyAndStudent(sequence: string | null) {
    if (!sequence) return;

    const standaloneMatch = sequence.match(/^(\d{1,4})$/);
    const legacyMatch = sequence.match(/^(\d{2})-(\d{2})-(\d{4})(?:-(\d+))?$/);
    const seqNumberStr = standaloneMatch?.[1] || legacyMatch?.[4] || null;
    const seqNumber = seqNumberStr ? parseInt(seqNumberStr, 10) : null;
    if (!seqNumber) return;

     // The QR selects the classroom; the handwritten number selects the
     // student within it. Without a classroom, accept only one unambiguous
     // student match across the account.
     if (!this.selectedStudentId && seqNumber) {
       const classroomId = this.selectedClassroomId;
       const studentsInClassroom = classroomId
         ? this.students.filter(s => s.classroomId === classroomId)
         : this.students;

       const matches = studentsInClassroom.filter(s => s.sequentialNumber === seqNumber);
       if (matches.length === 1) {
         this.selectedStudentId = matches[0].id;
         this.autoSelectedStudentId = matches[0].id;
       }
     }
   }

  onStudentSelectionChange() {
    // A user-selected student is an intentional lock for manual/batch work.
    // Only IDs populated by OCR/sequence matching are cleared automatically.
    this.autoSelectedStudentId = null;
  }

   openCameraMode() {
    this.scanMode = 'camera';
  }

  openUploadMode() {
    this.scanMode = 'upload';
  }

  onSegmentChange(event: any) {
    this.scanMode = event.detail.value;
  }

  onAnswerKeyChange() {
    // A homography tracked for one printed form must not be reused after the
    // operator selects another form/template.
    this.resetTrackingSession();
  }

  private getTrackingAnswerKeyIdentity(): string {
    return this.selectedAnswerKeyId == null
      ? 'answer-key:auto'
      : `answer-key:${this.selectedAnswerKeyId}`;
  }

  private createTrackingSessionId(): string {
    const randomPart = Math.random().toString(36).slice(2, 12);
    return `camera-${Date.now().toString(36)}-${randomPart}`;
  }

  private beginTrackingSession(): void {
    this.trackingSessionId = this.createTrackingSessionId();
    this.trackingFrameSequence = 0;
    this.trackingAnswerKeyIdentity = this.getTrackingAnswerKeyIdentity();
  }

  private endTrackingSession(): void {
    this.trackingSessionId = null;
    this.trackingFrameSequence = 0;
    this.trackingAnswerKeyIdentity = '';
  }

  private resetTrackingSession(): void {
    this.endTrackingSession();
    if (this.isScannerActive) this.beginTrackingSession();
  }

  private nextTrackingFrame(): { trackingSessionId: string; frameId: string } {
    const answerKeyIdentity = this.getTrackingAnswerKeyIdentity();
    if (
      !this.trackingSessionId
      || this.trackingAnswerKeyIdentity !== answerKeyIdentity
    ) {
      this.beginTrackingSession();
    }
    this.trackingFrameSequence += 1;
    return {
      trackingSessionId: this.trackingSessionId!,
      frameId: String(this.trackingFrameSequence)
    };
  }

  toggleScanner() {
    this.toggleEsp32Camera();
  }

  toggleEsp32Camera() {
    this.isScannerActive = !this.isScannerActive;
    if (this.isScannerActive) {
      this.capturedImage = null;
      this.streamFrameBlobUrl = null;
      this.streamErrorCount = 0;
      this.streamError = false;

      if (!this.espCamUrl) {
        this.showToastMessage('Please set camera URL first');
        this.isScannerActive = false;
        this.endTrackingSession();
        return;
      }

      this.beginTrackingSession();
      this.updateCameraUrls();

      if (this.autoScanEnabled) {
        this.startAutoDetection();
      }

      console.log('Starting camera poll from:', this.espCamCaptureUrl);
      this.startStreamPoll();
    } else {
      this.stopAutoDetection();
      this.stopStreamPoll();
      this.cleanupStream();
      this.espCamStreamUrl = '';
      this.awaitingSheetRemoval = false;
      this.noSheetFrames = 0;
      this.endTrackingSession();
    }
  }

  cleanupStream() {
    this.isPolling = false;
    this.stopStreamPoll();
    if (this.streamFrameBlobUrl && !this.isScannerActive) {
      URL.revokeObjectURL(this.streamFrameBlobUrl);
      this.streamFrameBlobUrl = null;
    }
    this.espCamStreamUrl = '';
    this.streamError = false;
    this.streamErrorCount = 0;
    this.liveDetection = null;
    this.liveConfidence = 0;
    this.liveConfidenceColor = 'danger';
    this.liveDetectionStatus = 'idle';
    this.liveQualityMessage = '';
    this.liveDebugMessage = '';
    this.liveAnswerPreview = [];
    this.recentLiveQualities = [];
    this.examSheetDetection = null;
    this.examSheetConfidence = 0;
    this.examSheetConfidenceColor = 'danger';
    this.examSheetRecommendation = '';
  }

  stopStreamPoll() {
    if (this.streamPollTimer) {
      clearTimeout(this.streamPollTimer);
      this.streamPollTimer = null;
    }
    if (this.streamAbortController) {
      this.streamAbortController.abort();
      this.streamAbortController = null;
    }
  }

  private scheduleNextPoll(delayMs: number) {
    this.stopStreamPoll();
    this.streamPollTimer = setTimeout(() => {
      if (!this.isScannerActive) return;
      this.pollFrame();
    }, delayMs);
  }

  private startStreamPoll() {
    this.stopStreamPoll();
    this.streamErrorCount = 0;
    this.streamError = false;
    this.isPolling = true;
    this.streamAbortController = new AbortController();
    this.pollFrame();
  }

  private pollFrame() {
    if (!this.isScannerActive) {
      this.isPolling = false;
      return;
    }

    const url = `${this.espCamCaptureUrl}?t=${Date.now()}`;
    const ctrl = this.streamAbortController;
    const baseOpts = { responseType: 'blob' as const };
    const opts = ctrl ? { ...baseOpts, signal: ctrl.signal } : baseOpts;
    this.http.get(url, opts).pipe(
      timeout(6000)
    ).subscribe({
      next: (blob) => {
        if (!this.isScannerActive) {
          this.isPolling = false;
          return;
        }

        if (!blob || blob.size === 0) {
          this.streamErrorCount++;
          if (this.streamErrorCount >= this.MAX_STREAM_ERRORS) {
            this.streamError = true;
            this.showToastMessage('Camera feed empty. Check connection.');
          }
          this.scheduleNextPoll(this.POLL_INTERVAL_MS);
          return;
        }

        this.streamErrorCount = 0;
        this.streamError = false;

        if (!this.streamFrameBlobUrl) {
          const newUrl = URL.createObjectURL(blob);
          this.streamFrameBlobUrl = newUrl;
          this.scheduleNextPoll(this.POLL_INTERVAL_MS);
        } else {
          const prev = this.streamFrameBlobUrl;
          const newUrl = URL.createObjectURL(blob);
          this.streamFrameBlobUrl = newUrl;
          URL.revokeObjectURL(prev);
          this.scheduleNextPoll(this.POLL_INTERVAL_MS);
        }
      },
      error: (err) => {
        this.isPolling = false;
        if (err.name === 'AbortError') return;
        if (!this.isScannerActive) return;
        this.streamErrorCount++;
        if (this.streamErrorCount >= this.MAX_STREAM_ERRORS) {
          this.streamError = true;
          this.showToastMessage('Stream error: camera feed lost');
        }
        const backoff = Math.min(this.POLL_INTERVAL_MS * (1 + Math.floor(this.streamErrorCount / 2)), 2000);
        this.scheduleNextPoll(backoff);
      }
    });
  }

  onAutoScanChange(event: any) {
    this.autoScanEnabled = event.detail.checked;
    this.liveDebugMessage = '';
    if (this.isScannerActive && this.autoScanEnabled) {
      this.startAutoDetection();
    } else if (!this.autoScanEnabled) {
      this.stopAutoDetection();
      this.clearAutoScanCooldown();
      this.awaitingSheetRemoval = false;
      this.noSheetFrames = 0;
      this.liveDetectionStatus = 'idle';
      this.liveQualityMessage = '';
      this.liveConfidence = 0;
      this.liveAnswerPreview = [];
      this.recentLiveQualities = [];
    }
  }

  captureImage() {
    if (!this.espCamCaptureUrl) {
      this.showToastMessage('Camera URL missing — check URL field');
      this.isProcessing = false;
      return;
    }

    if (!this.isScannerActive) {
      this.showToastMessage('Camera is not active');
      this.isProcessing = false;
      return;
    }

    this.autoCapturedScan = false;
    this.isProcessing = true;
    this.stopStreamPoll();

    const captureUrl = `${this.espCamCaptureUrl}?t=${Date.now()}`;
    this.showToastMessage('Capturing image...');
    console.log('Starting capture from:', captureUrl);

    this.http.get(captureUrl, { responseType: 'blob' }).pipe(
      timeout(15000)
    ).subscribe({
      next: (blob) => {
        if (!blob || blob.size === 0) {
          console.warn('Empty image received from camera');
          this.showToastMessage('Empty image received from camera');
          this.isProcessing = false;
          return;
        }

        console.log('Image captured successfully, size:', blob.size);

        const reader = new FileReader();
        reader.onloadend = () => {
          const base64data = reader.result as string;
          console.log('Image converted to base64, length:', base64data.length);
          this.showToastMessage('Processing captured image...');
          // Preserve the untouched camera frame. The backend's adaptive OMR
          // uses the paper edges to normalize perspective; browser-side
          // thresholding/cropping destroys that geometry on off-centre pages.
          this.capturedImage = base64data;
          this.isScannerActive = false;
          this.endTrackingSession();
          this.stopAutoDetection();
          this.cleanupStream();
          this.showToastMessage('Image captured! Processing scan...');
          setTimeout(() => this.processCapturedImage(), 50);
        };
        reader.onerror = (event) => {
          console.error('Failed to read captured image:', event);
          this.showToastMessage('Failed to read captured image');
          this.isProcessing = false;
        };
        reader.readAsDataURL(blob);
      },
      error: (err) => {
        console.error('Error capturing image from camera:', err);
        this.showToastMessage('Capture failed. Tap Start Camera to resume live view.');
        this.isProcessing = false;
        this.cleanupStream();
      }
    });
  }

  startAutoDetection() {
    if (!this.espCamCaptureUrl) {
      this.showToastMessage('Camera URL missing');
      this.autoScanEnabled = false;
      return;
    }
    if (Date.now() < this.autoScanCooldownUntil) {
      this.liveDetectionStatus = 'processing';
      this.liveQualityMessage = `Next auto-scan available in ${this.autoScanCooldownSeconds}s`;
    }
    this.stopAutoDetection();
    this.detectionActive = true;
    this.performAutoDetection();
    this.autoCaptureTimer = setInterval(() => {
      if (this.isScannerActive && this.autoScanEnabled && !this.isProcessing && !this.capturedImage && !this.autoDetectionInFlight) {
        this.performAutoDetection();
      }
    }, this.DETECTION_INTERVAL_MS);
  }

  async retryLiveDetection() {
    if (!this.isScannerActive) {
      this.showToastMessage('Start the camera first');
      return;
    }
    this.liveDebugMessage = '';
    try {
      await this.performAutoDetection();
    } catch (err) {
      console.error('Retry detection failed:', err);
    }
  }

  stopAutoDetection() {
    this.detectionActive = false;
    if (this.autoCaptureTimer) {
      clearInterval(this.autoCaptureTimer);
      this.autoCaptureTimer = null;
    }
    this.autoDetectionInFlight = false;
    this.stableDetectionSignature = '';
    this.stableDetectionFrames = 0;
  }

  onAutoRecordChange(event: any) {
    this.autoRecordEnabled = !!event.detail.checked;
    if (!this.autoRecordEnabled) {
      this.autoPrintEnabled = false;
      localStorage.setItem('scanner.autoPrint', 'false');
    }
    localStorage.setItem('scanner.autoRecord', String(this.autoRecordEnabled));
  }

  onAutoPrintChange(event: any) {
    this.autoPrintEnabled = !!event.detail.checked;
    if (this.autoPrintEnabled) {
      this.autoRecordEnabled = true;
      localStorage.setItem('scanner.autoRecord', 'true');
    }
    localStorage.setItem('scanner.autoPrint', String(this.autoPrintEnabled));
  }

  /**
    * Auto-scan: Capture frame and run real-time OMR detection
    * If confidence is high enough, automatically grade and save result
    */
  private async performAutoDetection() {
    const now = Date.now();
    if (this.autoDetectionInFlight || now - this.lastProcessedTime < this.DEBOUNCE_MS) return;
    this.autoDetectionInFlight = true;

    try {
      const captureUrl = `${this.espCamCaptureUrl}?t=${Date.now()}`;
      const captureBlob = await this.http.get(captureUrl, { responseType: 'blob' }).toPromise();
      if (!captureBlob) {
        this.autoDetectionInFlight = false;
        return;
      }

      const reader = new FileReader();
      reader.onload = async () => {
        // A 1600px grayscale JPEG retains the bubble detail of a full page
        // while avoiding repeated multi-megabyte camera uploads and Python
        // form reads during the live preview.
          try {
            const liveFrame = await this.preprocessImage(reader.result as string, 1600);
            const base64Image = liveFrame.split(',')[1];
            const answerKeyObj = this.answerKeys.find(k => k.id === this.selectedAnswerKeyId) || null;
            const answerKeyStr = answerKeyObj?.answerKey || '';
            if (!answerKeyStr) {
              this.liveDebugMessage = 'Looking for answer-key QR code...';
              this.liveDetectionStatus = 'scanning';
              this.liveQualityMessage = 'Show the QR code and the complete answer sheet';
            }
            const numChoices = answerKeyStr
              ? Math.max(4, new Set(answerKeyStr.replace(/\s/g, '').toUpperCase().split('')).size)
              : 4;
            let detectionResponse;
            try {
              const trackingFrame = this.nextTrackingFrame();
              detectionResponse = await this.scanService.detectFrame({
                imageBuffer: base64Image,
                answerKey: answerKeyStr || undefined,
                answerKeyId: answerKeyObj?.id,
                answerKeyDate: answerKeyObj?.answerKeyDate,
                numChoices,
                trackingSessionId: trackingFrame.trackingSessionId,
                frameId: trackingFrame.frameId,
                previewOnly: true
              }).toPromise();
            } catch (err) {
              // Grading has one authoritative, fail-closed backend path. The
              // Pi supplies camera frames only; its legacy proportional grid
              // must never become a slow or weaker grading fallback.
              console.warn('Authoritative detect-frame request failed:', err);
              throw err;
            }

            if (!detectionResponse?.success) {
              console.warn('Detection failed:', detectionResponse?.message);
              const msg = detectionResponse?.message || 'Detection failed';
              this.liveDebugMessage = `Detection failed: ${msg}`;
              this.showToastMessage(`Detection: ${msg}`);
              this.recordLiveFrame(0, 0, 0, []);
              this.liveDetectionStatus = 'reject';
              this.liveQualityMessage = msg;
              return;
            }

            const detectedAnswers = detectionResponse.detectedAnswers || [];
            const confidenceScores = detectionResponse.confidenceScores || [];
            const avgConfidence = detectionResponse.averageConfidence || 0;
            const detectedAnswerKeyId = detectionResponse.answerKeyId;
            const allDetected = detectedAnswers.every((a: string) => a !== '');
            const recommendation = (detectionResponse as any).qualityGate?.recommendation;

            const filledCount = detectedAnswers.filter((a: string) => a && String(a).trim() !== '').length;
            const markedRows = Array.isArray((detectionResponse as any).markedLetters)
              ? (detectionResponse as any).markedLetters
              : [];
            const completeRowMap = detectedAnswers.length === 50 && markedRows.length === 50;

            const placement = (detectionResponse as any).placement
              || (detectionResponse as any).details?.placement;
            const rejectionReason = String(
              (detectionResponse as any).qualityGate?.reason
              || (detectionResponse as any).details?.rejectionReason
              || ''
            );
            const sheetPresence = (detectionResponse as any).sheetPresence
              ?? (detectionResponse as any).details?.sheetPresence;
            // Registration failure is not proof that the previous sheet was
            // removed. New backends emit an explicit tri-state presence
            // signal; retain the old boundary heuristic only for rolling
            // deployments where that field is genuinely absent.
            const confirmedNoSheet = sheetPresence === 'absent'
              || (
                (sheetPresence === undefined || sheetPresence === null)
                && recommendation === 'reject'
                && (
                  placement?.detected === false
                  || (!placement && /answer sheet boundary not found/i.test(rejectionReason))
                )
              );

            // A new physical page cannot be proven from its answers: two
            // students may submit identical responses and template/header
            // hashes move under rotation. After a successful grade, require
            // two explicit no-page frames before accepting another sheet.
            if (this.awaitingSheetRemoval) {
              this.noSheetFrames = confirmedNoSheet ? this.noSheetFrames + 1 : 0;
              if (this.noSheetFrames >= this.REQUIRED_NO_SHEET_FRAMES) {
                this.awaitingSheetRemoval = false;
                this.noSheetFrames = 0;
                this.resetTrackingSession();
                this.lastCapturedSignature = '';
                this.lastCapturedFingerprint = '';
                this.stableDetectionSignature = '';
                this.stableDetectionFrames = 0;
                this.liveDetectionStatus = 'scanning';
                this.liveQualityMessage = 'Previous sheet removed. Ready for the next sheet';
              } else {
                this.liveDetectionStatus = 'scanning';
                this.liveQualityMessage = confirmedNoSheet
                  ? `Confirming sheet removal ${this.noSheetFrames}/${this.REQUIRED_NO_SHEET_FRAMES}`
                  : 'Remove the previous sheet completely before scanning the next one';
              }
              return;
            }

            this.liveDetection = detectionResponse;
            this.recordLiveFrame(
              avgConfidence,
              filledCount,
              detectedAnswers.length,
              detectedAnswers as string[],
              completeRowMap,
              recommendation === 'accept'
            );
            this.liveDebugMessage = '';

            const detectionSignature = markedRows
              .map((row: string[]) => Array.isArray(row) && row.length ? row.join('') : '-')
              .join('');
            if (detectionSignature && detectionSignature === this.stableDetectionSignature) {
              this.stableDetectionFrames++;
            } else {
              this.stableDetectionSignature = detectionSignature;
              this.stableDetectionFrames = 1;
            }

            const ambiguousRows = ((detectionResponse as any).markedLetters || [])
              .filter((row: string[]) => Array.isArray(row) && row.length > 1).length;
            const source = (detectionResponse as any).details?.source;
            const trustedGeometry = (detectionResponse as any).details?.currentSheetGeometry === true
              && !['adaptive-ring-diagnostic', 'adaptive-multiple-marks'].includes(source);
            const detectionIsReady = recommendation === 'accept'
              && detectedAnswers.length === 50
              && (ambiguousRows > 0 ? avgConfidence >= 60 : avgConfidence >= this.FRAME_CONFIDENCE_ACCEPT);
            // A current-sheet component/ring grid has independently verified
            // all 50 row positions. Camera auto-exposure can change a few
            // borderline rows in the next frame, so do not throw away this
            // stronger result waiting for an exact duplicate signature.
            const verifiedCurrentSheetRead = ['fast-hybrid-grid', 'adaptive-multi-mark-grid', 'adaptive-solid-mark-grid', 'adaptive-ring-grid'].includes(source)
              && avgConfidence >= 95;
            const stableFramesRequired = verifiedCurrentSheetRead ? 1 : this.REQUIRED_STABLE_FRAMES;
            const shouldAutoCapture = detectionIsReady
              && this.stableDetectionFrames >= stableFramesRequired
              && now >= this.autoScanCooldownUntil;

            if (shouldAutoCapture) {
              const sheetFingerprint = String((detectionResponse as any).details?.sheetFingerprint || '');
              const fingerprintDistance = this.fingerprintDistance(
                sheetFingerprint,
                this.lastCapturedFingerprint
              );
              const samePhysicalSheet = detectionSignature === this.lastCapturedSignature
                && (!sheetFingerprint || !this.lastCapturedFingerprint || fingerprintDistance <= 7);
              if (samePhysicalSheet) {
                this.liveDetectionStatus = 'scanning';
                this.liveQualityMessage = 'Remove the previous sheet before scanning the next one';
                this.stableDetectionFrames = 0;
                return;
              }
              console.log(`Auto-capturing with ${avgConfidence.toFixed(1)}% average confidence`);
              this.isProcessing = true;
              this.liveDetectionStatus = 'accept';
              this.showToastMessage(`Capturing (${avgConfidence.toFixed(1)}% confidence)`);
              this.lastProcessedTime = now;
              this.pendingCapturedSignature = detectionSignature;
              this.pendingCapturedFingerprint = sheetFingerprint;
              this.stopAutoDetection();

              if (detectedAnswerKeyId && !this.selectedAnswerKeyId) {
                this.selectedAnswerKeyId = detectedAnswerKeyId;
              }

              const detectedClassroomId = Number((detectionResponse as any).classroomId || 0);
              if (
                detectedClassroomId > 0
                && detectedClassroomId !== this.selectedClassroomId
              ) {
                this.selectedClassroomId = detectedClassroomId;
                await this.onClassroomChange();
              }

              const detectedSeq = (detectionResponse as any).sequence || (detectionResponse as any).rawOcrText || '';
              if (detectedSeq) {
                await this.autoPickAnswerKeyAndStudent(detectedSeq);
              }

              this.liveDetectionStatus = 'processing';
              this.autoCapturedScan = true;
              this.capturedImage = reader.result as string;
              this.isScannerActive = false;
              this.endTrackingSession();
              setTimeout(() => this.processCapturedImage(), 50);
            } else {
              const cooldownActive = now < this.autoScanCooldownUntil;
              const reason = ambiguousRows > 0 && trustedGeometry
                ? `${ambiguousRows} multi-mark row${ambiguousRows === 1 ? '' : 's'} will score zero`
                : recommendation
                ? ((detectionResponse as any).qualityGate.reason || 'Scanning...')
                : (!allDetected
                  ? 'Incomplete marks'
                  : avgConfidence < this.FRAME_CONFIDENCE_WARN
                    ? 'Low confidence'
                    : avgConfidence < this.FRAME_CONFIDENCE_ACCEPT
                      ? 'Scanning...'
                      : 'Awaiting quality');
              const stabilityMessage = detectionIsReady
                ? (cooldownActive
                  ? `Next auto-scan available in ${this.autoScanCooldownSeconds}s`
                  : `Confirming stable scan ${this.stableDetectionFrames}/${stableFramesRequired}`)
                : reason;
              this.liveQualityMessage = stabilityMessage;
              this.liveDetectionStatus = recommendation === 'reject' ? 'reject' : (recommendation === 'accept' ? 'accept' : 'scanning');
              if (!recommendation) {
                this.liveDetectionStatus = avgConfidence < this.FRAME_CONFIDENCE_WARN ? 'reject' : 'scanning';
              }
              console.log(`Detection waiting: ${avgConfidence.toFixed(1)}% confidence, ${filledCount}/${detectedAnswers.length} detected — ${reason}`);
            }
          } catch (error: any) {
            console.error('OMR detection error:', error);
            const reason = error?.message || 'Detection error';
            this.liveDebugMessage = `Auto-scan error: ${reason}`;
            this.liveDetectionStatus = 'reject';
            this.liveQualityMessage = reason;
          } finally {
            this.autoDetectionInFlight = false;
          }
        };
        reader.onerror = () => {
          this.autoDetectionInFlight = false;
          this.liveDetectionStatus = 'reject';
          this.liveQualityMessage = 'Could not read camera frame';
        };
        reader.readAsDataURL(captureBlob);
    } catch (error: any) {
      console.error('Auto-detection error:', error);
      this.liveDebugMessage = `Auto-scan error: ${error?.message || 'Unknown error'}`;
      this.liveDetectionStatus = 'reject';
      this.liveQualityMessage = error?.message || 'Detection error';
      this.autoDetectionInFlight = false;
    }
  }

  onFileSelected(event: any) {
    const file: File = event.target.files?.[0];
    if (!file) return;

    const validTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/bmp', 'image/tiff'];
    if (!validTypes.includes(file.type)) {
      this.showToastMessage('Please select a valid image file (JPEG, PNG, GIF, BMP, TIFF)');
      return;
    }

    if (file.size > 10 * 1024 * 1024) {
      this.showToastMessage('File size must be less than 10MB');
      return;
    }

    // Preprocess the image
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result as string;
      this.preprocessImage(base64).then(processedBase64 => {
        // Convert processed base64 to File
        const processedFile = this.base64ToFile(processedBase64, file.name);
        this.selectedFile = processedFile;
        this.previewUrl = processedBase64; // data URL for preview
      }).catch(err => {
        console.error('Preprocessing failed:', err);
        this.showToastMessage('Image preprocessing failed, using original image');
        // Fall back to original file
        this.selectedFile = file;
        this.previewUrl = URL.createObjectURL(file);
      });
    };
    reader.onerror = () => {
      this.showToastMessage('Failed to read file');
    };
    reader.readAsDataURL(file);
  }

  onDragOver(event: DragEvent) {
    event.preventDefault();
    this.isDragOver = true;
  }

  onDragLeave(event: DragEvent) {
    event.preventDefault();
    this.isDragOver = false;
  }

  onDrop(event: DragEvent) {
    event.preventDefault();
    this.isDragOver = false;
    const dt = event.dataTransfer;
    if (!dt) return;
    const file = dt.files[0];
    if (file) {
      const input = document.createElement('input');
      input.type = 'file';
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      input.files = dataTransfer.files;
      this.onFileSelected({ target: input });
    }
  }

  clearSelection() {
    this.selectedFile = null;
    this.previewUrl = null;
  }

  clearCameraMode() {
    this.stopStreamPoll();
    this.stopAutoDetection();
    this.clearAutoScanCooldown();
    this.cleanupStream();
    this.endTrackingSession();
    this.isScannerActive = false;
    this.isProcessing = false;
    this.capturedImage = null;
    this.streamFrameBlobUrl = null;
    this.streamError = false;
    this.streamErrorCount = 0;
    this.autoScanEnabled = false;
    this.selectedAnswerKeyId = null;
    this.selectedClassroomId = null;
    this.selectedStudentId = null;
    this.autoSelectedStudentId = null;
    this.awaitingSheetRemoval = false;
    this.noSheetFrames = 0;
    this.lastCapturedSignature = '';
    this.lastCapturedFingerprint = '';
    this.students = [];
  }

  private base64ToFile(base64: string, filename: string): File {
    const arr = base64.split(',');
    const mime = arr[0].match(/:(.*?);/)?.[1] || 'image/jpeg';
    const bstr = atob(arr[1]);
    let n = bstr.length;
    const u8arr = new Uint8Array(n);
    while (n--) {
      u8arr[n] = bstr.charCodeAt(n);
    }
    return new File([u8arr], filename, { type: mime });
  }

  /**
   * Lightweight preprocess: resize and grayscale only.
   * We intentionally do NOT apply binary threshold here because the
   * backend's calculateShadingDensity operates on the raw intensity buffer
   * (from its own greyscale step). A client-side hard threshold destroys
   * pencil/gel marking intensity gradients entirely and leads to inaccurate
   * bubble detection. The backend now applies its own adaptive threshold.
   */
  private preprocessImage(base64Image: string, maxDimension = 3840): Promise<string> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        let width = img.width;
        let height = img.height;
        if (width > height && width > maxDimension) {
          height = Math.round((height * maxDimension) / width);
          width = maxDimension;
        } else if (height > width && height > maxDimension) {
          width = Math.round((width * maxDimension) / height);
          height = maxDimension;
        }
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('Could not get canvas context'));
          return;
        }
        canvas.width = width;
        canvas.height = height;
        // Let the browser's native canvas pipeline perform grayscale during
        // the resize. getImageData + a JavaScript loop copied and touched
        // every pixel before every live request.
        ctx.filter = 'grayscale(100%)';
        ctx.drawImage(img, 0, 0, width, height);
        const processedBase64 = canvas.toDataURL('image/jpeg', 0.88);
        resolve(processedBase64);
      };
      img.onerror = (err) => reject(err);
      img.src = base64Image;
    });
  }

  async uploadAndProcess() {
    if (!this.selectedFile) {
      this.showToastMessage('Please select an image file first');
      return;
    }

    this.isProcessing = true;
    this.uploadProgress = 0;

    try {
      const response = await this.scanService.uploadScan(
        this.selectedFile,
        this.selectedClassroomId || undefined,
        this.selectedAnswerKeyId || undefined,
        this.selectedStudentId || undefined,
        undefined,
        undefined
      ).toPromise();

      if (!response) {
        throw new Error('No response from server');
      }

      this.showToastMessage('Upload complete. Processing with AI...');
      this.currentScan = { ...response.scan, scan_status: 'pending' };

      await this.processScan(response.scanId);
    } catch (error: any) {
      console.error('Upload error:', error);
      this.showToastMessage(error.message || 'Upload failed');
    } finally {
      this.isProcessing = false;
      this.uploadProgress = 0;
    }
  }

  async processCapturedImage() {
    if (!this.capturedImage) {
      this.isProcessing = false;
      return;
    }

    try {
      const file = this.base64ToFile(this.capturedImage, 'capture.jpg');
      const uploadResponse = await this.scanService.uploadScan(
        file,
        this.selectedClassroomId || undefined,
        this.selectedAnswerKeyId || undefined,
        this.selectedStudentId || undefined,
        undefined,
        undefined
      ).toPromise();

      if (!uploadResponse || !uploadResponse.scanId) {
        throw new Error('Failed to upload image');
      }

      await this.processScan(uploadResponse.scanId);
    } catch (error: any) {
      console.error('Camera scan error:', error);
      const serverMsg = error.error?.message || error.error?.error || error.message;
      this.showToastMessage(serverMsg || 'Failed to process captured image');
    } finally {
      this.isProcessing = false;
      this.resumeAutoScanAfterProcessing();
    }
  }

  private resumeAutoScanAfterProcessing() {
    if (!this.autoScanEnabled || this.scanMode !== 'camera' || !this.espCamUrl) return;
    this.capturedImage = null;
    const remaining = this.autoScanCooldownUntil - Date.now();
    if (remaining > 0) {
      this.isScannerActive = true;
      if (!this.trackingSessionId) this.beginTrackingSession();
      this.updateCameraUrls();
      this.startStreamPoll();
      // Keep observing frames during the short result cooldown so removal of
      // the previous sheet is not missed.
      this.startAutoDetection();
      this.liveDetectionStatus = 'processing';
      this.liveQualityMessage = `Result ready. Next auto-scan available in ${this.autoScanCooldownSeconds}s`;
      if (!this.autoScanCooldownTimer) {
        this.autoScanCooldownTimer = setTimeout(() => {
          this.autoScanCooldownTimer = null;
          this.autoScanCooldownSeconds = 0;
          this.resumeAutoScanAfterProcessing();
        }, remaining);
      }
      return;
    }
    this.isScannerActive = true;
    if (!this.trackingSessionId) this.beginTrackingSession();
    this.updateCameraUrls();
    this.startStreamPoll();
    this.startAutoDetection();
  }

  private beginAutoScanCooldown() {
    if (!this.autoCapturedScan || !this.autoScanEnabled || this.scanMode !== 'camera') return;
    this.autoCapturedScan = false;
    this.awaitingSheetRemoval = true;
    this.noSheetFrames = 0;
    if (this.autoSelectedStudentId && this.selectedStudentId === this.autoSelectedStudentId) {
      this.selectedStudentId = null;
    }
    this.autoSelectedStudentId = null;
    this.autoScanCooldownUntil = Date.now() + this.AUTO_SCAN_COOLDOWN_MS;
    this.autoScanCooldownSeconds = Math.ceil(this.AUTO_SCAN_COOLDOWN_MS / 1000);
    if (this.autoScanCooldownTimer) clearTimeout(this.autoScanCooldownTimer);
    this.autoScanCooldownTimer = setTimeout(() => {
      this.autoScanCooldownTimer = null;
      this.autoScanCooldownSeconds = 0;
      this.resumeAutoScanAfterProcessing();
    }, this.AUTO_SCAN_COOLDOWN_MS);
    this.liveDetectionStatus = 'processing';
    this.liveQualityMessage = 'Result ready. Waiting for the next sheet';
  }

  private clearAutoScanCooldown() {
    if (this.autoScanCooldownTimer) clearTimeout(this.autoScanCooldownTimer);
    this.autoScanCooldownTimer = null;
    this.autoScanCooldownUntil = 0;
    this.autoScanCooldownSeconds = 0;
  }

  async processScan(scanId: number) {
    console.log('Processing scan with ID:', scanId);
    try {
      const response = await this.scanService.processScan(scanId).toPromise();
      console.log('Process scan response:', response);

      if (response && response.success) {
        const scanWithExam = response.scan as any;
        this.currentScan = { ...scanWithExam, scan_status: 'completed' };
        if (this.autoCapturedScan && this.pendingCapturedSignature) {
          this.lastCapturedSignature = this.pendingCapturedSignature;
          this.lastCapturedFingerprint = this.pendingCapturedFingerprint;
          this.pendingCapturedSignature = '';
          this.pendingCapturedFingerprint = '';
        }
        const totalScore = scanWithExam.examResponse?.total_score || 0;
        const blankCount = Number(
          scanWithExam.answerDistribution?.unanswered
          ?? scanWithExam.omrResults?.filter((result: any) => !result.detected_answer && !(result.marked_letters?.length > 1)).length
          ?? 0
        );

        if (scanWithExam.sequence_detected) {
          await this.autoPickAnswerKeyAndStudent(scanWithExam.sequence_detected);
        }

        console.log('Scan completed successfully. Score:', totalScore);
        this.showToastMessage(
          `Scan processed! Score: ${totalScore} correct${blankCount > 0 ? `; ${blankCount} blank counted incorrect` : ''}`
        );
        this.beginAutoScanCooldown();

        const keepResult = this.autoRecordEnabled
          ? true
          : await this.showRecordResultPopup(scanId, totalScore, blankCount);
        if (keepResult) {
          this.loadScanHistory();
          this.loadStats();
          if (this.autoRecordEnabled) {
            this.showToastMessage('Result recorded automatically');
          }
          if (this.autoPrintEnabled) {
            console.log('Auto Print enabled; preparing score immediately...');
            await this.printScoreOnExamSheet(scanId, true);
            if (this.autoScanEnabled && this.scanMode === 'camera') {
              this.isProcessing = false;
              this.resumeAutoScanAfterProcessing();
            }
          } else {
            console.log('Result approved; showing print score popup...');
            await this.showPrintScorePopup(scanId, totalScore, blankCount);
          }
        }
      } else {
        const errorMsg = response?.message || 'Processing failed';
        console.error('Processing failed:', errorMsg);
        throw new Error(errorMsg);
      }
    } catch (error: any) {
      this.pendingCapturedSignature = '';
      this.pendingCapturedFingerprint = '';
      console.error('Processing error:', error);
      const serverMsg = error.error?.message || error.error?.error || error.message;
      const failure = error.error?.failure;
      this.lastScanFailure = failure || null;
      if (failure) {
        const artifactUrls = Array.isArray(failure.diagnosticArtifacts)
          ? failure.diagnosticArtifacts
          : [];
        const diagnosticPath = failure.diagnosticPath || artifactUrls[0] || '';
        const buttons: any[] = [];
        if (diagnosticPath) {
          buttons.push({
            text: 'Open diagnostics',
            handler: () => {
              const viewer = window.open('about:blank', '_blank');
              if (!viewer) {
                this.showToastMessage('Allow pop-ups to open scanner diagnostics.');
                return;
              }
              viewer.opener = null;
              viewer.document.title = 'Loading AcadCheck diagnostics';
              viewer.document.body.textContent = 'Loading protected diagnostics...';
              this.scanService.getDiagnosticResource(diagnosticPath).subscribe({
                next: diagnosticBlob => {
                  const objectUrl = URL.createObjectURL(diagnosticBlob);
                  viewer.location.replace(objectUrl);
                  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
                },
                error: diagnosticError => {
                  viewer.close();
                  this.showToastMessage(
                    diagnosticError?.message || 'Could not open scanner diagnostics.'
                  );
                }
              });
            }
          });
        }
        buttons.push({ text: 'Close', role: 'cancel' });
        const alert = await this.alertCtrl.create({
          header: 'Automatic grading withheld',
          subHeader: `Failed stage: ${failure.stage || 'quality gate'}`,
          message: [
            failure.reason || serverMsg || 'The sheet could not be graded safely.',
            failure.recommendation || 'Reposition the sheet and scan again.'
          ].join('<br><br>'),
          buttons
        });
        await alert.present();
      } else {
        this.showToastMessage(serverMsg || 'Processing failed');
      }
      if (this.currentScan) {
        this.currentScan.scan_status = 'failed';
        this.currentScan.error_message = serverMsg;
      }
      throw error;
    }
  }

  private fingerprintDistance(left: string, right: string): number {
    if (!left || !right || left.length !== right.length) return Number.MAX_SAFE_INTEGER;
    const bitCounts = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];
    let distance = 0;
    for (let index = 0; index < left.length; index++) {
      const leftNibble = parseInt(left[index], 16);
      const rightNibble = parseInt(right[index], 16);
      if (Number.isNaN(leftNibble) || Number.isNaN(rightNibble)) return Number.MAX_SAFE_INTEGER;
      const xor = leftNibble ^ rightNibble;
      distance += bitCounts[xor];
    }
    return distance;
  }

  async detectSequenceFromCamera() {
    if (!this.espCamCaptureUrl) {
      this.showToastMessage('Camera URL missing — check URL field');
      return;
    }

    this.isProcessing = true;
    this.showToastMessage('Detecting sequence from camera...');

    try {
      const captureUrl = `${this.espCamCaptureUrl}?t=${Date.now()}`;
      const blob = await this.http.get(captureUrl, { responseType: 'blob' }).toPromise();

      if (!blob || blob.size === 0) {
        this.showToastMessage('Failed to capture image from camera');
        this.isProcessing = false;
        return;
      }

      const reader = new FileReader();
      reader.onloadend = async () => {
        const base64data = reader.result as string;
        try {
          const response = await this.scanService.detectSequence(base64data.split(',')[1]).toPromise();
          if (response?.success && response.sequence) {
            this.showToastMessage(`Sequence detected: ${response.sequence} (${response.confidence}% confidence)`);
            this.currentScan = {
              ...this.currentScan,
              sequence_detected: response.sequence,
              scan_status: 'completed'
            };
            await this.autoPickAnswerKeyAndStudent(response.sequence);
          } else {
            this.showToastMessage('Sequence not detected. Try again with better lighting.');
          }
        } catch (err) {
          console.error('Sequence detection error:', err);
          this.showToastMessage('Sequence detection failed');
        } finally {
          this.isProcessing = false;
        }
      };
      reader.readAsDataURL(blob);
    } catch (error) {
      console.error('Camera capture error:', error);
      this.showToastMessage('Camera capture failed');
      this.isProcessing = false;
    }
  }

  async detectExamSheetFromCamera() {
    if (!this.espCamCaptureUrl) {
      this.showToastMessage('Camera URL missing — check URL field');
      return;
    }

    this.isProcessing = true;
    this.showToastMessage('Detecting exam sheet...');

    try {
      const captureUrl = `${this.espCamCaptureUrl}?t=${Date.now()}`;
      const blob = await this.http.get(captureUrl, { responseType: 'blob' }).toPromise();

      if (!blob || blob.size === 0) {
        this.showToastMessage('Failed to capture image from camera');
        this.isProcessing = false;
        return;
      }

      const reader = new FileReader();
      reader.onloadend = async () => {
        const base64data = reader.result as string;
        try {
          const response = await this.scanService.detectExamSheet(base64data.split(',')[1]).toPromise();
          if (response?.success && response.confidence > 0) {
            this.examSheetDetection = response;
            this.examSheetConfidence = response.confidence;
            this.examSheetConfidenceColor = response.confidence >= 75 ? 'success' : response.confidence >= 55 ? 'warning' : 'danger';
            this.examSheetRecommendation = response.recommendation || '';
            this.showToastMessage(`Exam sheet: ${response.isExamSheet ? 'Yes' : 'Uncertain'} (${response.confidence}% confidence)`);
          } else {
            this.examSheetDetection = null;
            this.examSheetConfidence = 0;
            this.examSheetConfidenceColor = 'danger';
            this.examSheetRecommendation = 'reject';
            this.showToastMessage('No exam sheet detected. Try again with better framing.');
          }
        } catch (err) {
          console.error('Exam sheet detection error:', err);
          this.showToastMessage('Exam sheet detection failed');
        } finally {
          this.isProcessing = false;
        }
      };
      reader.readAsDataURL(blob);
    } catch (error) {
      console.error('Camera capture error:', error);
      this.showToastMessage('Camera capture failed');
      this.isProcessing = false;
    }
  }

  async startCalibration() {
    if (!this.espCamCaptureUrl) {
      this.showToastMessage('Camera URL missing');
      return;
    }

    this.isCalibrating = true;
    this.calibrationImage = null;
    this.calibrationResults = null;
    this.showToastMessage('Capturing calibration image...');

    try {
      const captureUrl = `${this.espCamCaptureUrl}?t=${Date.now()}`;
      const blob = await this.http.get(captureUrl, { responseType: 'blob' }).toPromise();

      if (!blob || blob.size === 0) {
        this.showToastMessage('Failed to capture calibration image');
        this.isCalibrating = false;
        return;
      }

      const reader = new FileReader();
      reader.onloadend = async () => {
        this.calibrationImage = reader.result as string;
        this.showToastMessage('Calibration image captured. Analyzing...');

        try {
          const base64Data = this.calibrationImage.split(',')[1];
          const sequenceResponse = await this.scanService.detectSequence(base64Data, {
            bottomRegionHeight: 0.18,
            cropLeft: 0.08,
            cropRight: 0.92
          }).toPromise();

          this.calibrationResults = sequenceResponse;
          if (sequenceResponse?.success && sequenceResponse.sequence) {
            this.showToastMessage(`Calibration successful: ${sequenceResponse.sequence}`);
          } else {
            this.showToastMessage('Calibration: sequence not detected. Adjust camera position.');
          }
        } catch (err) {
          console.error('Calibration error:', err);
          this.showToastMessage('Calibration failed');
        } finally {
          this.isCalibrating = false;
        }
      };
      reader.readAsDataURL(blob);
    } catch (error) {
      console.error('Calibration capture error:', error);
      this.showToastMessage('Calibration capture failed');
      this.isCalibrating = false;
    }
  }

  clearCalibration() {
    this.calibrationImage = null;
    this.calibrationResults = null;
    this.isCalibrating = false;
  }

  async detectAnswerKeyQrFromCamera() {
    if (!this.espCamCaptureUrl) {
      this.showToastMessage('Camera URL missing — check URL field');
      return;
    }
    this.isProcessing = true;
    this.showToastMessage('Looking for the answer-key QR...');
    try {
      const captureUrl = `${this.espCamCaptureUrl}?t=${Date.now()}`;
      const blob = await this.http.get(captureUrl, { responseType: 'blob' }).toPromise();
      if (!blob) throw new Error('Camera returned no image');
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(new Error('Could not read the camera image'));
        reader.readAsDataURL(blob);
      });
      const prepared = await this.preprocessImage(dataUrl, 1600);
      const response = await this.scanService.detectAnswerKeyQr(prepared.split(',')[1]).toPromise();
      if (response?.detected && response.answerKeyId) {
        const answerKeyChanged = this.selectedAnswerKeyId !== response.answerKeyId;
        this.selectedAnswerKeyId = response.answerKeyId;
        if (answerKeyChanged) this.resetTrackingSession();
        if (response.classroomId) {
          this.selectedClassroomId = response.classroomId;
          await this.onClassroomChange();
        }
        if (response.sequence) {
          await this.autoPickAnswerKeyAndStudent(response.sequence);
        }
        this.showToastMessage(`QR verified: ${response.examTitle || 'answer key'}`);
      } else {
        this.showToastMessage(response?.message || 'No answer-key QR is visible');
      }
    } catch (error: any) {
      this.showToastMessage(error?.message || 'Answer-key QR detection failed');
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Require an explicit decision before the saved score can proceed to the
   * print dialog. Removing a result uses the backend's transactional delete,
   * which also removes its OMR/OCR rows and exam response.
   */
  private async showRecordResultPopup(scanId: number, totalScore: number, blankCount = 0): Promise<boolean> {
    const studentName = this.getSelectedStudentName();
    try {
      const alert = await this.alertCtrl.create({
        header: 'Record Scan Result?',
        message: `Student: ${studentName}<br><br>Score: <strong>${totalScore} correct</strong>${blankCount > 0 ? `<br>Blank answers: <strong>${blankCount}</strong> (counted incorrect)` : ''}<br><br>Do you want to record this result, or remove this scan?`,
        backdropDismiss: false,
        buttons: [
          {
            text: 'Remove Result',
            role: 'remove',
            cssClass: 'alert-button-danger'
          },
          {
            text: 'Record Result',
            role: 'record',
            cssClass: 'alert-button-confirm'
          }
        ]
      });

      await alert.present();
      const dismissal = await alert.onDidDismiss();
      if (dismissal.role === 'record') {
        this.showToastMessage('Result recorded successfully');
        return true;
      }

      if (dismissal.role === 'remove') {
        try {
          const result = await this.scanService.deleteScan(scanId).toPromise();
          if (!result?.success) throw new Error(result?.message || 'Failed to remove result');
          this.currentScan = null;
          this.loadScanHistory();
          this.loadStats();
          this.showToastMessage('Scan result removed');
        } catch (error: any) {
          console.error('Failed to remove scan result:', error);
          this.showToastMessage(error?.error?.message || error?.message || 'Failed to remove scan result');
        }
      }
      return false;
    } catch (error) {
      console.error('Failed to show record-result popup:', error);
      this.showToastMessage('Result is awaiting your review');
      return false;
    }
  }

  /**
    * Show a popup/dialog asking whether to print the score on the scanned exam sheet.
    * If confirmed, calls the backend to overlay the score onto the original scanned image.
    */
   private async showPrintScorePopup(scanId: number, totalScore: number, blankCount = 0) {
     console.log('Attempting to show print score popup...');
     const studentName = this.getSelectedStudentName();
     
     try {
       const alert = await this.alertCtrl.create({
         header: 'Print Score on Exam Sheet?',
         message: `Student: ${studentName}<br><br>Score: <strong>${totalScore} correct</strong>${blankCount > 0 ? `<br>Blank answers: <strong>${blankCount}</strong> (counted incorrect)` : ''}<br><br>Do you want to print this score onto the scanned exam sheet?`,
         backdropDismiss: false,
         buttons: [
           {
             text: 'Cancel',
             role: 'cancel',
             handler: () => {
               console.log('Print score cancelled');
             }
           },
           {
             text: 'Print Score',
             cssClass: 'primary',
             role: 'print'
           }
         ]
       });
       
       console.log('Alert created, presenting...');
       await alert.present();
       console.log('Alert presented successfully');
       const dismissal = await alert.onDidDismiss();
       if (dismissal.role === 'print') {
         await this.printScoreOnExamSheet(scanId);
       }
     } catch (error) {
       console.error('Failed to show print score popup:', error);
       this.showToastMessage('Scan complete! Check results below.');
     } finally {
       // This is the terminal interaction for a recorded camera scan. Resume
       // only after the user printed or explicitly cancelled the print step.
       if (this.autoScanEnabled && this.scanMode === 'camera') {
         this.isProcessing = false;
         this.resumeAutoScanAfterProcessing();
       }
     }
   }

  /**
   * Call the backend to overlay/print the score onto the original scanned exam sheet image.
   * The score is rendered directly onto the image file (no new paper).
   */
  async printScoreOnExamSheet(scanId: number, useInlineFrame: boolean = false) {
    this.showToastMessage('Preparing score for printing...');
    try {
      // Auto Print asks the backend PC to submit the job through its installed
      // Windows driver, so mobile clients need no local print service.
      const result = await this.scanService.printScoreOnExamSheet(scanId, useInlineFrame).toPromise();
      if (result?.success) {
        if (result?.printedDirectly) {
          this.showToastMessage(`Score sent to ${result.printerName || 'the server printer'}`);
          return;
        }
        if (useInlineFrame) {
          const printError = result?.directPrintError || 'The server printer did not accept the print job';
          console.error('Auto Print failed:', printError);
          this.showToastMessage(`Auto Print failed: ${printError}`);
          return;
        }
        const scoreImageUrl = result?.scoreImageUrl;
           if (scoreImageUrl) {
             if (useInlineFrame) {
               await this.printScoreInFrame(scoreImageUrl);
               return;
             }
             const printWindow = window.open('', '_blank', 'width=420,height=520');
             if (printWindow) {
               await new Promise<void>((resolve) => {
                 let settled = false;
                 const fallbackTimer = window.setTimeout(() => finish(), 60000);
                 const finish = () => {
                   if (settled) return;
                   settled = true;
                   window.clearTimeout(fallbackTimer);
                   resolve();
                 };
                 printWindow.onafterprint = finish;
               printWindow.document.write(`
                 <html>
                   <head>
                     <title>Print Score</title>
                     <style>
                       @page { size: auto; margin: 0; }
                       body { margin: 0; padding: 0 24px 28px 0; box-sizing: border-box; display: flex; justify-content: flex-end; align-items: flex-end; min-height: 100vh; background: #fff; }
                       img { max-width: 80px; max-height: 420px; }
                       @media print { body { background: #fff; margin: 0; } img { max-width: 80px; max-height: 420px; } }
                     </style>
                   </head>
                   <body>
                     <img src="${scoreImageUrl}" />
                   </body>
                 </html>
               `);
            printWindow.document.close();
            printWindow.onload = () => {
              printWindow.focus();
              try {
                printWindow.print();
              } finally {
                // Most browsers return from print() after Print/Cancel. The
                // afterprint event is preferred; this covers browsers that do
                // not emit it for a popup window.
                window.setTimeout(finish, 300);
              }
            };
               });
          } else {
            // Popup blockers commonly reject windows opened after an async
            // request. Fall back to a same-page iframe instead of requiring
            // users to weaken their browser security settings.
            await this.printScoreInFrame(scoreImageUrl);
          }
        } else {
          this.showToastMessage('Score prepared successfully, but image URL not available');
        }
      } else {
        this.showToastMessage(result?.message || 'Failed to print score');
      }
    } catch (error: any) {
      console.error('Print score error:', error);
      this.showToastMessage(error.error?.message || 'Failed to print score');
    }
  }

  private async printScoreInFrame(scoreImageUrl: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const frame = document.createElement('iframe');
      frame.setAttribute('title', 'Score print frame');
      frame.style.position = 'fixed';
      frame.style.right = '0';
      frame.style.bottom = '0';
      frame.style.width = '1px';
      frame.style.height = '1px';
      frame.style.opacity = '0';
      frame.style.border = '0';
      document.body.appendChild(frame);

      let settled = false;
      const cleanup = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(fallbackTimer);
        frame.remove();
        resolve();
      };
      const fallbackTimer = window.setTimeout(cleanup, 60000);
      const frameWindow = frame.contentWindow;
      const frameDocument = frame.contentDocument;
      if (!frameWindow || !frameDocument) {
        window.clearTimeout(fallbackTimer);
        frame.remove();
        reject(new Error('Print frame could not be created'));
        return;
      }

      frameWindow.onafterprint = cleanup;
      frameDocument.open();
      frameDocument.write(`
        <html>
          <head>
            <title>Print Score</title>
            <style>
              @page { size: auto; margin: 0; }
              html, body { margin: 0; background: #fff; }
              body { padding: 0 24px 28px 0; box-sizing: border-box; display: flex; justify-content: flex-end; align-items: flex-end; min-height: 100vh; }
              img { max-width: 80px; max-height: 420px; }
              @media print { img { max-width: 80px; max-height: 420px; } }
            </style>
          </head>
          <body>
            <img id="score-image" src="${scoreImageUrl}" />
          </body>
        </html>
      `);
      frameDocument.close();

      const image = frameDocument.getElementById('score-image') as HTMLImageElement | null;
      if (!image) {
        window.clearTimeout(fallbackTimer);
        frame.remove();
        reject(new Error('Score image could not be prepared for printing'));
        return;
      }
      const startPrint = () => {
        try {
          frameWindow.focus();
          frameWindow.print();
        } catch (error) {
          window.clearTimeout(fallbackTimer);
          frame.remove();
          reject(error);
        } finally {
          window.setTimeout(cleanup, 300);
        }
      };
      image.onload = startPrint;
      image.onerror = () => {
        window.clearTimeout(fallbackTimer);
        frame.remove();
        reject(new Error('Score image failed to load for printing'));
      };
      if (image.complete && image.naturalWidth > 0) startPrint();
    });
  }

   viewScanDetails(scan: any) {
     this.currentScan = scan;
   }

  getAnswersCount() {
    if (!this.currentScan?.examResponse?.answers_json) return 0;
    try {
      return Object.keys(JSON.parse(this.currentScan.examResponse.answers_json)).length;
    } catch {
      return 0;
    }
  }

    getSelectedStudentName(): string {
      if (this.selectedStudentId) {
        const student = this.students.find(s => s.id === this.selectedStudentId);
        if (student) return `${student.firstName} ${student.lastName}`;
      }
      if (this.currentScan?.student_full_name) return this.currentScan.student_full_name;
      if (this.currentScan?.student_name_detected) return this.currentScan.student_name_detected;
      return 'Unknown';
    }

    getSelectedKeyName(): string {
        if (this.selectedAnswerKeyId) {
            const key = this.answerKeys.find(k => k.id === this.selectedAnswerKeyId);
            if (key) return `${key.subject} - ${key.examTitle}`;
        }
        if (this.currentScan?.subject && this.currentScan?.exam_title) {
            return `${this.currentScan.subject} - ${this.currentScan.exam_title}`;
        }
        return '';
    }

    onStreamError() {
        if (!this.isScannerActive) return;

        this.streamErrorCount++;
        this.streamError = true;
        console.error('Error loading camera stream from:', this.espCamStreamUrl);
        console.error('Full URL:', this.espCamStreamUrl);

        console.log('Stream diagnostics:', {
            url: this.espCamStreamUrl,
            baseUrl: this.espCamUrl,
            isActive: this.isScannerActive,
            isPolling: this.isPolling,
            timestamp: new Date().toISOString()
        });

        if (this.streamErrorCount >= this.MAX_STREAM_ERRORS) {
          this.showToastMessage('⚠ Stream error - retrying...');
        }

        if (this.isScannerActive && !this.isPolling) {
          const backoff = Math.min(350 * (1 + Math.floor(this.streamErrorCount / 2)), 2000);
          this.scheduleNextPoll(backoff);
        } else if (this.isScannerActive && this.isPolling) {
          const backoff = Math.min(350 * (1 + Math.floor(this.streamErrorCount / 2)), 2000);
          this.stopStreamPoll();
          this.isPolling = false;
          this.scheduleNextPoll(backoff);
        }
    }

    testCameraDirectly() {
        if (!this.espCamCaptureUrl) {
            this.showToastMessage('Camera capture URL not configured');
            return;
        }

        this.showToastMessage('Testing camera /capture endpoint...');
        console.log('Testing direct capture from:', this.espCamCaptureUrl);

        const testUrl = `${this.espCamCaptureUrl}?t=${Date.now()}`;
        this.http.get(testUrl, { responseType: 'blob' }).pipe(
            timeout(5000)
        ).subscribe({
            next: (blob) => {
                console.log('✅ Capture endpoint working! Blob size:', blob.size);
                
                // Convert blob to data URL and display
                const reader = new FileReader();
                reader.onloadend = () => {
                    const img = document.querySelector('.camera-feed') as HTMLImageElement;
                    if (img) {
                        img.src = reader.result as string;
                        this.streamError = false;
                        this.showToastMessage('✅ Camera /capture is working! Loaded single frame.');
                        console.log('Successfully loaded capture image');
                    }
                };
                reader.readAsDataURL(blob);
            },
            error: (err) => {
                console.error('❌ /capture endpoint failed:', err);
                this.showToastMessage('❌ /capture endpoint not responding. Check ESP32 firmware.');
            }
        });
    }

    openInBrowser() {
        window.open(this.espCamUrl, '_blank');
    }

    showToastMessage(msg: string) {
        this.toastMessage = msg;
        this.showToast = true;
        setTimeout(() => this.showToast = false, 3000);
    }

    doRefresh(event: any) {
        this.loadScanHistory();
        this.loadStats();
        setTimeout(() => {
            event.detail.complete();
        }, 1000);
    }
}
