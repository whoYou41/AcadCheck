import { prepareScanImage } from '../../utils/prepare-scan-image';
import { Component, ElementRef, HostListener, OnInit, OnDestroy, ViewChild } from '@angular/core';
import { AlertController } from '@ionic/angular';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CameraHttpService, normalizedDirectPiUrl } from '../../services/camera-http.service';
import { firstValueFrom, Subscription } from 'rxjs';
import { finalize, timeout } from 'rxjs/operators';
import { Capacitor, registerPlugin } from '@capacitor/core';
import {
  IonContent, IonHeader, IonToolbar, IonTitle, IonButtons, IonGrid,
  IonRow, IonCol, IonCard, IonCardHeader, IonCardTitle, IonCardSubtitle, IonCardContent,
  IonButton, IonIcon, IonSelect, IonSelectOption, IonList, IonItem, IonLabel,
  IonBadge, IonMenuButton, IonToast, IonNote, IonText, IonAccordionGroup,
  IonAccordion, IonSegment, IonSegmentButton, IonSpinner,
  IonRefresher, IonRefresherContent, IonChip, IonInput, IonToggle
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  cameraOutline, flashOutline, schoolOutline, keyOutline, peopleOutline,
  personOutline, addCircleOutline, checkmarkCircleOutline, alertCircleOutline,
  timeOutline, closeCircleOutline, videocamOutline, globeOutline, bugOutline,
  cloudUploadOutline, refreshOutline,
  scanOutline, documentTextOutline, bookOutline, idCardOutline, trophyOutline,
  listOutline, eyeOutline, calculatorOutline, imageOutline, radioButtonOn,
  informationCircleOutline, chevronForwardOutline, warningOutline,
  calendarOutline, printOutline, playCircle, stopCircle
} from 'ionicons/icons';
import { AnswerKeyService } from '../../services/answer-key.service';
import { ScanService } from '../../services/scan.service';
import { AuthService } from '../../services/auth.service';
import { ClassroomService } from '../../services/classroom.service';
import { StudentService } from '../../services/student.service';
import { OfflineOmrOptions, OfflineOmrResult, OfflineOmrService } from '../../services/offline-omr.service';
import { UsbPrinterService, savedQuestionResults, savedScoreText } from '../../services/usb-printer.service';
import { buildScoreSheetOverlayDataUrl } from '../../utils/score-sheet-print';
import { environment } from '../../../environments/environment';

interface NativeOfflinePrintPlugin {
  printScore(options: {
    scoreText: string;
    studentName?: string;
    examTitle?: string;
    questionResults?: Array<{ questionNumber: number; isCorrect: boolean }>;
  }): Promise<{ success: boolean; jobName?: string }>;
}

const NativeOfflinePrint = registerPlugin<NativeOfflinePrintPlugin>('OfflinePrint');

interface ScanStats {
  totalScans: number;
  completedScans: number;
  pendingScans: number;
  failedScans: number;
}

interface LiveAnswerMarker {
  id: string;
  label: string;
  x: number;
  y: number;
  left: number;
  top: number;
  confidence: number;
  state: 'detected' | 'uncertain' | 'multiple';
}

interface ScannerGuideStep {
  target: string;
  title: string;
  description: string;
}

@Component({
  selector: 'app-scanner',
  templateUrl: './scanner.page.html',
  styleUrls: ['./scanner.page.scss'],
  standalone: true,
  imports: [
    CommonModule, FormsModule, IonContent, IonHeader, IonToolbar, IonTitle, IonButtons,
    IonMenuButton, IonGrid, IonRow, IonCol, IonCard, IonCardHeader,
    IonCardTitle, IonCardSubtitle, IonCardContent, IonButton, IonIcon, IonSelect, IonSelectOption,
    IonList, IonItem, IonLabel, IonBadge, IonToast, IonNote, IonText,
    IonAccordionGroup, IonAccordion, IonSegment, IonSegmentButton, IonSpinner,
    IonRefresher, IonRefresherContent, IonChip, IonInput, IonToggle
  ],
})
export class ScannerPage implements OnInit, OnDestroy {
  scanMode: 'camera' | 'upload' = 'camera';
  get isOfflineMode(): boolean { return this.authService.isOfflineMode(); }
  private scannerSessionMode: boolean | null = null;
  offlineAnswers: string[] = [];
  offlineConfidences: number[] = [];
  offlineMarkedLetters: string[][] = [];
  offlineReviewed: boolean[] = [];
  offlineGradeable = false;
  offlineFingerprint = '';
  offlineProcessingMs = 0;
  offlineOverallConfidence = 0;
  offlineAnchorMethod = '';
  offlineQrData = '';
  readonly offlineChoices = ['', 'A', 'B', 'C', 'D'];
  offlineDetectionStatus: 'idle' | 'detecting' | 'done' | 'error' = 'idle';
  offlineDetectionMessage = '';
  private offlineDetectionRun = 0;

  // Raspberry Pi camera service (acadacam)
  isScannerActive: boolean = false;
  readonly isStandaloneAndroid = Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
  private readonly backendCameraBaseUrl = `${String(environment.apiUrl || '/api').replace(/\/$/, '')}/camera`;
  cameraBaseUrl: string = environment.production
    ? this.backendCameraBaseUrl
    : localStorage.getItem('scanner.cameraUrl') || environment.defaultCameraUrl;
  cameraStreamUrl: string = '';
  cameraCaptureUrl: string = '';
  isDiscoveringCamera: boolean = false;
  capturedImage: string | null = null;
  streamFrameBlobUrl: string | null = null;
  streamPollTimer: any = null;
  streamErrorCount: number = 0;
  MAX_STREAM_ERRORS = 5;
  private readonly TRANSIENT_STREAM_ERROR_LIMIT = 3;
  POLL_INTERVAL_MS = 350;
  private readonly OFFLINE_POLL_INTERVAL_MS = 120;
  private readonly MAX_STREAM_RETRY_DELAY_MS = 8000;
  private readonly CAMERA_RESTART_COOLDOWN_MS = 12000;
  private streamPollGeneration = 0;
  private cameraSessionGeneration = 0;
  private cameraDiscoveryGeneration = 0;
  private cameraStartupTimer: ReturnType<typeof setTimeout> | null = null;
  private lastCameraFrameAt = 0;
  private lastCameraDiscoveryAt = 0;
  cameraFrameVisible = false;
  private nativeDetectionBusy = false;
  // Keep the real read latched across Stop/Start to prevent stale work queues.
  private liveDetectionBusy = false;
  private freshFrameDetectionTimer: ReturnType<typeof setTimeout> | null = null;
  private offlineNeedsDetailFrame = false;
  private offlineAutoStudentFingerprint = '';
  private offlineAutoStudentAt = 0;
  private offlineSequenceCandidate = '';
  private offlineSequenceCandidateFrames = 0;
  private offlineSequenceCandidateFingerprint = '';
  private offlineSequenceCandidateAt = 0;
  private readonly REQUIRED_SEQUENCE_CANDIDATE_FRAMES = 2;
  private readonly MIN_SEQUENCE_CANDIDATE_CONFIDENCE = 35;
  private cameraCaptureInFlight = false;
  private cameraHealthRetryTimer: any = null;
  private cameraHealthRetryAttempt = 0;
  private cameraHealthRequestInFlight = false;
  private lastCameraRestartAt = 0;
  private lastCameraErrorToastAt = 0;
  private destroyed = false;
  private cameraViewActive = true;
  private cameraRequestedActive = false;
  autoScanEnabled: boolean = true;
  autoRecordEnabled: boolean = false;
  autoPrintEnabled: boolean = false;
  detectionActive: boolean = false;
  autoDetectionInFlight: boolean = false;
  autoCaptureTimer: any = null;
  lastProcessedTime: number = 0;
  DEBOUNCE_MS = 300;
  DETECTION_INTERVAL_MS = 300;
  private readonly OFFLINE_DETECTION_INTERVAL_MS = 150;
  AUTO_SCAN_COOLDOWN_MS = 1500;
  private readonly OFFLINE_AUTO_SCAN_COOLDOWN_MS = 500;
  autoScanCooldownUntil: number = 0;
  autoScanCooldownSeconds: number = 0;
  autoScanCooldownTimer: any = null;
  private autoCapturedScan: boolean = false;
  REQUIRED_STABLE_FRAMES = 2;
  stableDetectionSignature: string = '';
  stableDetectionFrames: number = 0;
  private readonly OFFLINE_CONFIRMATION_MAX_AGE_MS = 20000;
  private offlineConfirmationAt = 0;
  private offlineConfirmationIdentity = '';
  private offlineConfirmationFingerprint = '';
  lastCapturedSignature: string = '';
  pendingCapturedSignature: string = '';
  lastCapturedFingerprint: string = '';
  pendingCapturedFingerprint: string = '';
  private pendingCapturedStudentId: number | null = null;
  private lastCapturedStudentId: number | null = null;
  private pendingCapturedSequence = '';
  private lastCapturedSequence = '';
  private awaitingSheetRemoval: boolean = false;
  private noSheetFrames: number = 0;
  private readonly REQUIRED_NO_SHEET_FRAMES = 2;
  private replacementSheetFingerprint = '';
  private replacementSheetFrames = 0;
  private readonly REQUIRED_REPLACEMENT_SHEET_FRAMES = 2;
  private readonly SAME_SHEET_FINGERPRINT_DISTANCE = 7;
  private readonly NEW_SHEET_IDENTITY_DISTANCE = 6;
  private autoDetectionGeneration = 0;
  private trackingSessionId: string | null = null;
  private trackingFrameSequence: number = 0;
  private trackingAnswerKeyIdentity: string = '';
  streamError: boolean = false;
  cameraHealthMessage = '';
  cameraRestartInFlight = false;
  isPolling: boolean = false;
  private streamRequestSubscription: Subscription | null = null;
  private latestOmrFrameBlob: Blob | null = null;
  private latestOmrFrameReceivedAt = 0;
  private lastAutoDetectionBlob: Blob | null = null;
  private readonly MAX_SHARED_OMR_FRAME_AGE_MS = 1200;

  // Live OMR overlay / quality gate
  liveDetection: any = null;
  liveResolvedRows = 0;
  get liveQuestionCount(): number {
    const count = Number(this.answerKeys.find(key => key.id === this.selectedAnswerKeyId)?.numQuestions || 50);
    return Number.isFinite(count) && count > 0 ? count : 50;
  }
  get liveScanProgress(): number {
    return this.isOfflineMode
      ? Math.min(100, 100 * this.liveResolvedRows / this.liveQuestionCount)
      : this.liveConfidence;
  }
  liveConfidence: number = 0;
  liveConfidenceColor: string = 'danger';
  liveDetectionStatus: 'idle' | 'scanning' | 'accept' | 'reject' | 'processing' = 'idle';
  liveQualityMessage: string = '';
  liveAnswerMarkers: LiveAnswerMarker[] = [];
  liveOverlayFrameBlobUrl: string | null = null;
  private liveOverlayWidth = 0;
  private liveOverlayHeight = 0;
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
  private loadedStudentClassroomId: number | null = null;

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

  // Realtime, in-place feature guide
  guideActive = false;
  guideStepIndex = 0;
  guideTargetRect = { top: 0, left: 0, width: 0, height: 0 };
  guideCardPosition = { top: 16, left: 16 };
  guidePlacement: 'top' | 'right' | 'bottom' | 'left' = 'bottom';
  guideTargetVisible = false;
  private guideRefreshTimer: any = null;

  // File input
  @ViewChild('fileInput') fileInput!: any;
  @ViewChild('cameraInput') cameraInput!: ElementRef<HTMLInputElement>;
  @ViewChild('deviceVideo') deviceVideo!: ElementRef<HTMLVideoElement>;
  @ViewChild('cameraFeed') cameraFeed?: ElementRef<HTMLImageElement>;

  // File upload
  selectedFile: File | null = null;
  private imageSelectionRun = 0;
  previewUrl: string | null = null;
  isDragOver = false;
  isDeviceCameraActive = false;
  isStartingDeviceCamera = false;
  deviceCameraError = '';
  private deviceCameraStream: MediaStream | null = null;

    constructor(
    private answerKeyService: AnswerKeyService,
    private scanService: ScanService,
    private authService: AuthService,
    private classroomService: ClassroomService,
    private studentService: StudentService,
    private offlineOmrService: OfflineOmrService,
    private http: CameraHttpService,
    public usbPrinter: UsbPrinterService,
    private alertCtrl: AlertController
    ) {
    addIcons({
    cameraOutline, flashOutline, schoolOutline, keyOutline, peopleOutline,
    personOutline, addCircleOutline, checkmarkCircleOutline, alertCircleOutline,
    timeOutline, closeCircleOutline, videocamOutline, globeOutline, bugOutline,
    cloudUploadOutline, refreshOutline,
    scanOutline, documentTextOutline, bookOutline, idCardOutline, trophyOutline,
    listOutline, eyeOutline, calculatorOutline, imageOutline, radioButtonOn,
    informationCircleOutline, chevronForwardOutline, warningOutline,
    calendarOutline, printOutline, playCircle, stopCircle
    });
    }

  androidPrintDestination: 'usb' | 'system' = localStorage.getItem('scanner.androidPrintDestination') === 'system' ? 'system' : 'usb';
  printerMessage = '';

  savePrintDestination(): void {
    localStorage.setItem('scanner.androidPrintDestination', this.androidPrintDestination);
  }

  async refreshUsbPrinters(): Promise<void> {
    try {
      await this.usbPrinter.initialize();
      await this.usbPrinter.refresh();
      this.printerMessage = this.usbPrinter.state.connected
        ? 'Epson L120 connected. Load 8.5 x 13-inch long bond paper, bottom/QR edge first.'
        : this.usbPrinter.state.devices.length ? 'Printer detected. Tap Connect to allow USB access.'
          : 'No Epson USB printer found. Turn on the L120 and check the OTG adapter and cable.';
    } catch (error: any) {
      this.printerMessage = error?.message || 'Could not detect USB printers.';
    }
  }

  async connectUsbPrinter(): Promise<void> {
    try {
      await this.refreshUsbPrinters();
      const devices = this.usbPrinter.state.devices;
      if (!devices.length) return;
      let deviceName = devices[0].deviceName;
      if (devices.length > 1) {
        const picker = await this.alertCtrl.create({
          header: 'Select Epson printer',
          inputs: devices.map(device => ({
            type: 'radio' as const, label: device.productName + ' (' + device.deviceName + ')', value: device.deviceName
          })),
          buttons: [{ text: 'Cancel', role: 'cancel' }, { text: 'Connect', role: 'confirm' }]
        });
        await picker.present();
        const result = await picker.onDidDismiss();
        if (result.role !== 'confirm' || !result.data?.values) return;
        deviceName = result.data.values;
      }
      await this.usbPrinter.connect(deviceName);
      this.printerMessage = 'Epson L120 connected. Use a blank 8.5 x 13-inch long bond sheet for the first test.';
    } catch (error: any) {
      this.printerMessage = error?.message || 'Could not connect to the printer.';
    }
  }

  async disconnectUsbPrinter(): Promise<void> {
    try {
      await this.usbPrinter.disconnect();
      this.printerMessage = 'Printer disconnected from AcadCheck.';
    } catch (error: any) { this.printerMessage = error?.message || 'Could not disconnect.'; }
  }

  async testUsbPrinter(): Promise<void> {
    const alert = await this.alertCtrl.create({
      header: 'Print test page',
      message: 'Load one blank 8.5 x 13-inch long bond sheet. AcadCheck will print a red 50/50 score horizontally beside the right-hand ANSWER SHEET heading. Load the bottom/QR edge first.',
      buttons: [{ text: 'Cancel', role: 'cancel' }, { text: 'Print', role: 'confirm' }]
    });
    await alert.present();
    if ((await alert.onDidDismiss()).role !== 'confirm') return;
    try {
      const result = await this.usbPrinter.print('50/50', true);
      this.printerMessage = 'Test data sent to ' + result.printerName + '. Check the page and alignment.';
    } catch (error: any) { this.printerMessage = error?.message || 'USB test print failed.'; }
  }

  private async printAndroidScore(scan: any): Promise<void> {
    const scoreText = savedScoreText(scan);
    if (this.androidPrintDestination === 'system' && !this.autoPrintEnabled) {
      await NativeOfflinePrint.printScore({ scoreText, questionResults: savedQuestionResults(scan) });
      this.showToastMessage('Android print dialog opened for ' + scoreText);
      return;
    }
    const result = await this.usbPrinter.print(scoreText, false, savedQuestionResults(scan));
    this.showToastMessage('Score sent to ' + result.printerName + '. Check the printed page.');
  }

  ngOnInit() {
    if (this.isStandaloneAndroid) void this.refreshUsbPrinters();
    this.destroyed = false;
    this.cameraViewActive = true;
    this.scannerSessionMode = this.isOfflineMode;
    // Offline HTTP browsers and Android reach the Pi over LAN. HTTPS browsers
    // retain the bridge because browsers block HTTP camera requests from HTTPS.
    if (this.isOfflineMode) {
      this.cameraBaseUrl = this.usesDirectPiConnection
        ? this.preferredDirectPiUrl()
        : this.backendCameraBaseUrl;
    }
    this.loadAutomationPreferences();
    this.loadReferenceData();
    this.loadScanHistory();
    this.loadStats();
    const savedDirectAddress = this.normalizedDirectPiUrl(
      localStorage.getItem('scanner.directPiUrl')
        || localStorage.getItem('scanner.cameraUrl')
    );
    this.updateCameraUrls();
    // A saved direct address can begin previewing immediately when the user
    // starts the camera. Probing it during page construction creates a second
    // request which competes with the first JPEG on slower Pi/Wi-Fi links.
    if (!this.usesDirectPiConnection || !savedDirectAddress) {
      this.discoverAcadcam(true);
    }
  }

  private loadAutomationPreferences(): void {
    const autoRecord = localStorage.getItem(this.automationPreferenceKey('autoRecord'));
    this.autoRecordEnabled = autoRecord === null ? this.isOfflineMode : autoRecord === 'true';
    this.autoPrintEnabled = localStorage.getItem(this.automationPreferenceKey('autoPrint')) === 'true';
    if (this.autoPrintEnabled) this.autoRecordEnabled = true;
  }

  private synchronizeScannerMode(): boolean {
    const offline = this.isOfflineMode;
    if (this.scannerSessionMode == null) {
      this.scannerSessionMode = offline;
      return false;
    }
    if (this.scannerSessionMode === offline) return false;
    // Ionic retains routed pages. Never carry local IDs, accepted frames, or
    // duplicate barriers into an online database session (or vice versa).
    this.scannerSessionMode = offline;
    this.cameraRequestedActive = false;
    this.stopExternalCameraSession();
    this.clearAutoScanCooldown();
    this.clearSelection();
    this.capturedImage = null;
    this.currentScan = null;
    this.selectedAnswerKeyId = null;
    this.selectedClassroomId = null;
    this.selectedStudentId = null;
    this.students = [];
    this.answerKeys = [];
    this.classrooms = [];
    this.scanHistory = [];
    this.studentsLoaded = false;
    this.loadedStudentClassroomId = null;
    this.studentSequenceReviewRequired = false;
    this.awaitingSheetRemoval = false;
    this.autoCapturedScan = false;
    this.pendingCapturedSignature = '';
    this.pendingCapturedFingerprint = '';
    this.pendingCapturedStudentId = null;
    this.pendingCapturedSequence = '';
    this.lastCapturedSignature = '';
    this.lastCapturedFingerprint = '';
    this.lastCapturedStudentId = null;
    this.lastCapturedSequence = '';
    this.clearOfflineSequenceCandidate();
    this.isProcessing = false;
    this.cameraBaseUrl = this.usesDirectPiConnection ? this.preferredDirectPiUrl() : this.backendCameraBaseUrl;
    this.updateCameraUrls();
    this.loadAutomationPreferences();
    this.loadReferenceData();
    this.loadScanHistory();
    this.loadStats();
    return true;
  }

  get usesDirectPiConnection(): boolean {
    // Offline browser sessions served over local HTTP can reach the Pi on the
    // same LAN directly. Routing them back through /api/camera loses the
    // operator-entered address and fails whenever the backend tunnel is not
    // configured. HTTPS pages retain the backend bridge because browsers
    // block an HTTP Pi as mixed content.
    return this.isOfflineMode && (
      this.isStandaloneAndroid
      || window.location.protocol === 'http:'
    );
  }

  get scannerGuideSteps(): ScannerGuideStep[] {
    const sourceIsCamera = this.scanMode === 'camera';
    const sourceStep: ScannerGuideStep = sourceIsCamera
      ? {
          target: 'camera-source',
          title: 'Same-Wi-Fi Raspberry Pi',
          description: this.isOfflineMode
            ? this.usesDirectPiConnection
              ? 'AcadCheck reaches the Pi directly. Internet access is not required; both devices only need the same Wi-Fi.'
              : 'AcadCheck reaches the Pi through the local backend. Internet access is not required; both devices only need the same Wi-Fi.'
            : 'Detect the Raspberry Pi automatically, or enter its local address, then keep Auto-Scan enabled for live feedback.',
        }
      : {
          target: 'upload-source',
          title: 'Device camera or upload',
          description: 'Take a new photo, use the camera app, or select an existing image. Every option keeps the complete freely placed sheet visible.',
        };
    const feedbackStep: ScannerGuideStep = sourceIsCamera
      ? {
          target: 'camera-feedback',
          title: 'Realtime detection',
          description: 'The preview reports sheet confidence while you move it. Hold the full page steady and well lit until the status turns ready.',
        }
      : {
          target: this.isOfflineMode && !!this.selectedFile ? 'offline-review' : 'upload-area',
          title: this.isOfflineMode && !!this.selectedFile ? 'Verify uncertain answers' : 'Choose an answer-sheet image',
          description: this.isOfflineMode && !!this.selectedFile
            ? 'Detection runs on this device. Only highlighted rows need correction before the local grade can be saved.'
            : 'Drop or browse for a clear JPEG or PNG. Detection begins as soon as the image is prepared.',
        };
    const actionStep: ScannerGuideStep = sourceIsCamera
      ? {
          target: 'camera-actions',
          title: 'Start, watch, and grade',
          description: 'Start Camera opens the LAN preview. Auto-Scan reads continuously; Scan & Grade captures the current frame for a final verified result.',
        }
      : {
          target: this.isOfflineMode && !!this.selectedFile ? 'offline-grade' : 'upload-area',
          title: this.isOfflineMode ? 'Save locally' : 'Scan and grade',
          description: this.isOfflineMode
            ? 'After selecting a classroom and student and reviewing uncertain rows, save the grade on this device.'
            : 'Submit the prepared image to the scanner after choosing its answer key.',
        };

    return [
      ...(this.isOfflineMode ? [{
        target: 'offline-status',
        title: 'Offline still includes the camera',
        description: 'Only cloud access is off. Raspberry Pi camera, device camera, uploads, detection, grading, and local history remain available.',
      }] : []),
      {
        target: 'scan-mode',
        title: 'Choose a source',
        description: 'Switch between Raspberry Pi Camera and Upload at any time. This guide follows the tab you choose and explains its live controls.',
      },
      {
        target: 'scan-config',
        title: 'Identify the exam',
        description: 'Choose the answer key first. In Offline Mode, also choose the local classroom and student before saving a grade.',
      },
      sourceStep,
      feedbackStep,
      actionStep,
    ];
  }

  get currentGuideStep(): ScannerGuideStep | null {
    const steps = this.scannerGuideSteps;
    return steps[this.guideStepIndex] || null;
  }

  get guideRealtimeStatus(): string {
    if (this.scanMode === 'camera') {
      if (this.isDiscoveringCamera) return 'Searching the local Wi-Fi for acadacam…';
      if (this.streamError) return this.cameraHealthMessage || 'Camera reconnecting on the local network…';
      if (this.isScannerActive) return this.liveQualityMessage || 'Camera connected. Waiting for a complete answer sheet.';
      return this.cameraBaseUrl
        ? `${this.usesDirectPiConnection ? 'Direct Pi connection' : 'Local camera bridge'} is ready. Select an answer key, then start the camera.`
        : 'No camera address is set yet. Use Detect acadacam.';
    }
    if (this.offlineDetectionStatus === 'detecting') return this.offlineDetectionMessage;
    if (this.selectedFile) return this.offlineDetectionMessage || 'Image ready for review.';
    return 'Choose the device camera or upload an answer-sheet image.';
  }

  startRealtimeGuide(): void {
    this.guideActive = true;
    this.guideStepIndex = 0;
    this.refreshGuideTarget(true);
    if (this.guideRefreshTimer) clearInterval(this.guideRefreshTimer);
    this.guideRefreshTimer = setInterval(() => this.refreshGuideTarget(), 400);
  }

  closeRealtimeGuide(): void {
    this.guideActive = false;
    this.guideTargetVisible = false;
    if (this.guideRefreshTimer) clearInterval(this.guideRefreshTimer);
    this.guideRefreshTimer = null;
  }

  previousGuideStep(): void {
    if (this.guideStepIndex <= 0) return;
    this.guideStepIndex--;
    this.refreshGuideTarget(true);
  }

  nextGuideStep(): void {
    if (this.guideStepIndex >= this.scannerGuideSteps.length - 1) {
      this.closeRealtimeGuide();
      return;
    }
    this.guideStepIndex++;
    this.refreshGuideTarget(true);
  }

  private refreshGuideTarget(scrollToTarget = false): void {
    if (!this.guideActive) return;
    const step = this.currentGuideStep;
    const target = step
      ? document.querySelector<HTMLElement>(`[data-scanner-guide=${step.target}]`)
      : null;
    if (!target) {
      this.guideTargetVisible = false;
      return;
    }
    if (scrollToTarget) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
      setTimeout(() => this.refreshGuideTarget(), 350);
    }
    const rect = target.getBoundingClientRect();
    this.guideTargetRect = {
      top: Math.max(4, rect.top - 6),
      left: Math.max(4, rect.left - 6),
      width: Math.max(20, rect.width + 12),
      height: Math.max(20, rect.height + 12),
    };
    this.guideTargetVisible = rect.bottom > 0
      && rect.right > 0
      && rect.top < window.innerHeight
      && rect.left < window.innerWidth;

    const cardWidth = Math.min(340, window.innerWidth - 24);
    const cardHeight = 230;
    const gap = 18;
    if (rect.right + gap + cardWidth <= window.innerWidth) {
      this.guidePlacement = 'right';
      this.guideCardPosition = {
        left: rect.right + gap,
        top: Math.max(12, Math.min(rect.top, window.innerHeight - cardHeight - 12)),
      };
    } else if (rect.left - gap - cardWidth >= 0) {
      this.guidePlacement = 'left';
      this.guideCardPosition = {
        left: rect.left - gap - cardWidth,
        top: Math.max(12, Math.min(rect.top, window.innerHeight - cardHeight - 12)),
      };
    } else if (rect.bottom + gap + cardHeight <= window.innerHeight) {
      this.guidePlacement = 'bottom';
      this.guideCardPosition = {
        left: Math.max(12, Math.min(rect.left + rect.width / 2 - cardWidth / 2, window.innerWidth - cardWidth - 12)),
        top: rect.bottom + gap,
      };
    } else {
      this.guidePlacement = 'top';
      this.guideCardPosition = {
        left: Math.max(12, Math.min(rect.left + rect.width / 2 - cardWidth / 2, window.innerWidth - cardWidth - 12)),
        top: Math.max(12, rect.top - cardHeight - gap),
      };
    }
  }

  updateCameraUrls() {
    // Ensure URL doesn't end with slash for proper concatenation.
    // Hosted HTTPS traffic stays on the authenticated backend. Offline APKs
    // and locally served HTTP browsers accept only private/local Pi addresses.
    const baseUrl = (
      this.usesDirectPiConnection
        ? this.normalizedDirectPiUrl(this.cameraBaseUrl) || ''
        : environment.production || this.isOfflineMode
          ? this.backendCameraBaseUrl
          : this.cameraBaseUrl
    ).trim().replace(/\/+$/, '');
    this.cameraBaseUrl = baseUrl;
    this.cameraStreamUrl = baseUrl ? `${baseUrl}/stream` : '';
    this.cameraCaptureUrl = baseUrl ? `${baseUrl}/capture` : '';
    if (baseUrl) {
      localStorage.setItem(
        this.usesDirectPiConnection ? 'scanner.directPiUrl' : 'scanner.cameraUrl',
        baseUrl
      );
    }
  }

  private normalizedDirectPiUrl(value: string | null | undefined): string | null {
    return normalizedDirectPiUrl(value);
  }

  private preferredDirectPiUrl(): string {
    return this.normalizedDirectPiUrl(localStorage.getItem('scanner.directPiUrl'))
      || this.normalizedDirectPiUrl(localStorage.getItem('scanner.cameraUrl'))
      || 'http://acadacam.local:5000';
  }

  private directPiCandidates(): string[] {
    const candidates = [
      this.cameraBaseUrl,
      localStorage.getItem('scanner.directPiUrl'),
      localStorage.getItem('scanner.workingPiUrl'),
      'http://192.168.254.104:5000',
      'http://acadacam.local:5000',
      'http://acadacam:5000',
      'http://acadcam.local:5000',
      'http://acadcam:5000',
      'http://192.168.1.137:5000',
    ]
      .map(value => this.normalizedDirectPiUrl(value))
      .filter((value): value is string => !!value);
    return [...new Set(candidates)];
  }

  private cameraCaptureRequestUrl(previewOnly = false): string {
    if (!this.cameraCaptureUrl) return '';
    const separator = this.cameraCaptureUrl.includes('?') ? '&' : '?';
    // Open the preview with a small first image. OMR uses the larger profile
    // so a narrow sheet retains enough pixels per bubble.
    const captureProfile = this.usesDirectPiConnection
      ? previewOnly ? 'max_width=960&quality=80'
        : this.offlineNeedsDetailFrame ? 'max_width=1920&quality=92' : 'max_width=1440&quality=86'
      : this.offlineNeedsDetailFrame ? 'max_width=1920&quality=92' : 'max_width=1440&quality=92';
    return `${this.cameraCaptureUrl}${separator}${captureProfile}&t=${Date.now()}`;
  }

  private updateLiveDetailRequirement(sheetPresence: unknown, unresolved: boolean): void {
    // Both runtimes need actual camera detail for faint or distant marks.
    // Retain that detail through confirmation; reset when the sheet leaves.
    this.offlineNeedsDetailFrame = sheetPresence !== 'absent'
      && (this.offlineNeedsDetailFrame || unresolved);
  }

  private cameraRequestHeaders(url: string): Record<string, string> {
    try {
      const target = new URL(url, window.location.origin);
      const proxy = new URL(this.backendCameraBaseUrl, window.location.origin);
      const proxyPath = proxy.pathname.replace(/\/+$/, '');
      const isBackendProxy = target.origin === proxy.origin
        && (target.pathname === proxyPath || target.pathname.startsWith(`${proxyPath}/`));
      if (!isBackendProxy) return {};
      const token = localStorage.getItem('token');
      return token ? { Authorization: `Bearer ${token}` } : {};
    } catch {
      return {};
    }
  }

  private rememberOmrFrame(blob: Blob): void {
    this.latestOmrFrameBlob = blob;
    this.latestOmrFrameReceivedAt = Date.now();
    this.queueFreshFrameDetection();
  }

  private queueFreshFrameDetection(): void {
    if (this.freshFrameDetectionTimer != null
      || this.liveDetectionBusy || this.autoDetectionInFlight || this.nativeDetectionBusy
      || !this.isCurrentAutoDetection(this.autoDetectionGeneration)
      || this.isProcessing || this.capturedImage || !this.selectedAnswerKeyId
      || !this.freshUnprocessedOmrFrame()) return;
    // Yield for the preview to paint, then consume only the latest frame.
    // The periodic timer remains a watchdog for cooldowns and selection changes.
    this.freshFrameDetectionTimer = setTimeout(() => {
      this.freshFrameDetectionTimer = null;
      void this.performAutoDetection();
    }, Math.max(0, this.DEBOUNCE_MS - (Date.now() - this.lastProcessedTime)));
  }

  private freshUnprocessedOmrFrame(): Blob | null {
    const blob = this.latestOmrFrameBlob;
    if (
      !blob
      || blob === this.lastAutoDetectionBlob
      || Date.now() - this.latestOmrFrameReceivedAt > this.MAX_SHARED_OMR_FRAME_AGE_MS
    ) return null;
    return blob;
  }

  private clearSharedCameraFrames(): void {
    this.latestOmrFrameBlob = null;
    this.latestOmrFrameReceivedAt = 0;
    this.lastAutoDetectionBlob = null;
  }

  discoverAcadcam(silent = false) {
    if (this.isDiscoveringCamera) return;
    const discoveryGeneration = ++this.cameraDiscoveryGeneration;
    this.isDiscoveringCamera = true;
    if (!silent) this.showToastMessage('Looking for acadacam on the local network...');

    if (this.usesDirectPiConnection) {
      void this.discoverDirectPi(discoveryGeneration, silent);
      return;
    }

    this.scanService.discoverAcadcam().pipe(timeout(10000)).subscribe({
      next: (result) => {
        if (discoveryGeneration !== this.cameraDiscoveryGeneration) return;
        this.isDiscoveringCamera = false;
        if (this.destroyed) return;
        if (!result?.success || !result.cameraUrl) return;
        const discovery = result as any;
        const previousUrl = this.cameraBaseUrl;
        this.cameraBaseUrl = result.cameraUrl;
        this.updateCameraUrls();
        const activeCameraUrlChanged = this.isScannerActive && previousUrl !== this.cameraBaseUrl;
        if (activeCameraUrlChanged) {
          this.cameraSessionGeneration++;
          this.stopStreamPoll();
          this.stopAutoDetection();
          this.resetTrackingSession();
        }
        if (result.cameraInitialized === false || discovery.frameAvailable === false) {
          this.streamError = true;
          this.cameraHealthMessage = discovery.hint
            || discovery.lastError
            || 'Camera service found, but the camera is not producing frames.';
          if (!silent) this.showToastMessage(this.cameraHealthMessage);
          if (this.isScannerActive) {
            const retryAfterMs = Math.max(500, Number(discovery.retryAfterMs || 1000));
            if (discovery.recoveryInProgress) {
              this.scheduleCameraHealthRetry(retryAfterMs);
            } else {
              this.requestCameraRestart();
            }
          }
          return;
        }
        this.markCameraHealthy();
        if (!silent) this.showToastMessage(`acadacam detected at ${result.ipAddress}`);
        if (this.isScannerActive) {
          if (activeCameraUrlChanged) {
            // DHCP can move acadacam while this page is open. Invalidate every
            // callback tied to the old host before starting the discovered one.
            if (this.autoScanEnabled) this.startAutoDetection();
          }
          // A discovery probe is often triggered while the poll loop is in a
          // long backoff. Restart immediately once the service proves healthy.
          this.startStreamPoll();
        }
      },
      error: (error) => {
        if (discoveryGeneration !== this.cameraDiscoveryGeneration) return;
        this.isDiscoveringCamera = false;
        if (this.destroyed) return;
        console.warn('Automatic acadcam discovery failed:', error);
        this.streamError = true;
        this.cameraHealthMessage = 'acadacam was not found on this Wi-Fi. Confirm both devices are connected to the same local network.';
        if (!silent) {
          this.showToastMessage(this.cameraHealthMessage);
        }
      }
    });
  }

  private async discoverDirectPi(discoveryGeneration: number, silent: boolean): Promise<void> {
    const candidates = this.directPiCandidates();
    const startedAt = Date.now();
    this.lastCameraDiscoveryAt = startedAt;
    const startingUrl = this.cameraBaseUrl;
    // A healthy IP must not wait for its paired .local DNS lookup.
    const result = await new Promise<any | null>(resolve => {
      let next = 0;
      let running = 2;
      let finished = false;
      let reachable: any = null;
      const probe = async () => {
        while (!finished && next < candidates.length && discoveryGeneration === this.cameraDiscoveryGeneration) {
          const candidate = await this.probeDirectPi(candidates[next++]);
          if (candidate) {
            reachable ||= candidate;
            if (candidate.cameraInitialized && candidate.frameAvailable) {
              finished = true;
              resolve(candidate);
            }
          }
        }
        if (--running === 0 && !finished) resolve(reachable);
      };
      void probe();
      void probe();
    });
    if (discoveryGeneration !== this.cameraDiscoveryGeneration || this.destroyed) return;
    this.isDiscoveringCamera = false;
    if (this.cameraBaseUrl !== startingUrl || this.lastCameraFrameAt > startedAt) return;
    if (!result) {
      this.streamError = true;
      this.cameraHealthMessage = 'acadacam was not found. Enter the Pi address shown by hostname -I, then tap Test Connection.';
      if (!silent) this.showToastMessage(this.cameraHealthMessage);
      return;
    }
    const previousUrl = this.cameraBaseUrl;
    this.cameraBaseUrl = result.cameraUrl;
    this.updateCameraUrls();
    const activeCameraUrlChanged = this.isScannerActive && previousUrl !== this.cameraBaseUrl;
    if (activeCameraUrlChanged) {
      this.cameraSessionGeneration++;
      this.stopStreamPoll();
      this.stopAutoDetection();
      this.resetTrackingSession();
    }
    if (result.cameraInitialized === false || result.frameAvailable === false) {
      this.streamError = true;
      this.cameraHealthMessage = result.hint
        || result.lastError
        || 'Camera service found, but the camera is not producing frames.';
      if (!silent) this.showToastMessage(this.cameraHealthMessage);
      if (this.isScannerActive) {
        if (result.recoveryInProgress) {
          this.scheduleCameraHealthRetry(1000);
        } else {
          this.requestCameraRestart();
        }
      }
      return;
    }
    this.markCameraHealthy();
    if (!silent) this.showToastMessage(`acadacam detected at ${result.ipAddress}`);
    if (this.isScannerActive) {
      if (activeCameraUrlChanged && this.autoScanEnabled) this.startAutoDetection();
      this.startStreamPoll();
    }
  }

  private async probeDirectPi(cameraUrl: string): Promise<any | null> {
    try {
      const status = await firstValueFrom(
        this.http.get<any>(`${cameraUrl}/status`).pipe(timeout(5500))
      );
      if (
        !status
        || typeof status.camera_initialized !== 'boolean'
      ) return null;
      const hostname = new URL(cameraUrl).hostname;
      return {
        success: true,
        cameraUrl,
        hostname,
        ipAddress: hostname,
        cameraInitialized: status.camera_initialized === true,
        frameAvailable: status.frame_available !== false,
        recoveryInProgress: status.recovery_in_progress === true,
        lastError: status.last_error,
        hint: status.hint,
        transport: 'direct-lan',
      };
    } catch {
      return null;
    }
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

  onCameraFrameLoaded() {
    this.cameraFrameVisible = true;
    if (this.liveAnswerMarkers.length > 0) {
      requestAnimationFrame(() => this.layoutLiveAnswerMarkers());
    }
  }

  private updateLiveAnswerOverlay(response: any, frame: Blob) {
    const overlay = response?.details?.overlayGeometry;
    const width = Number(overlay?.width);
    const height = Number(overlay?.height);
    const centers = overlay?.centers;
    const detectedAnswers = Array.isArray(response?.detectedAnswers)
      ? response.detectedAnswers
      : [];
    const markedLetters = Array.isArray(response?.markedLetters)
      ? response.markedLetters
      : [];
    const confidences = Array.isArray(response?.confidenceScores)
      ? response.confidenceScores
      : [];

    if (
      !Number.isFinite(width)
      || !Number.isFinite(height)
      || width <= 0
      || height <= 0
      || !Array.isArray(centers)
      || centers.length !== 50
    ) {
      this.clearLiveAnswerOverlay();
      return;
    }

    const markers: LiveAnswerMarker[] = [];
    const choices = ['A', 'B', 'C', 'D'];
    for (let rowIndex = 0; rowIndex < centers.length; rowIndex++) {
      const rowCenters = centers[rowIndex];
      if (!Array.isArray(rowCenters) || rowCenters.length !== 4) continue;
      const explicitMarks = Array.isArray(markedLetters[rowIndex])
        ? markedLetters[rowIndex]
            .map((choice: unknown) => String(choice || '').toUpperCase())
            .filter((choice: string) => choices.includes(choice))
        : [];
      const detected = String(detectedAnswers[rowIndex] || '').toUpperCase();
      const marks = explicitMarks.length > 0
        ? [...new Set<string>(explicitMarks)]
        : choices.includes(detected)
          ? [detected]
          : [];
      const confidence = Math.max(0, Math.min(100, Number(confidences[rowIndex]) || 0));

      for (const answer of marks) {
        const choiceIndex = choices.indexOf(answer);
        const center = rowCenters[choiceIndex];
        const x = Number(center?.[0]);
        const y = Number(center?.[1]);
        if (
          !Number.isFinite(x)
          || !Number.isFinite(y)
          || x < 0
          || y < 0
          || x > width
          || y > height
        ) continue;
        markers.push({
          id: `${rowIndex + 1}-${answer}`,
          label: `${rowIndex + 1}.${answer}`,
          x,
          y,
          left: 0,
          top: 0,
          confidence,
          state: marks.length > 1
            ? 'multiple'
            : confidence < 70
              ? 'uncertain'
              : 'detected'
        });
      }
    }

    if (markers.length === 0) {
      this.clearLiveAnswerOverlay();
      return;
    }

    this.liveOverlayWidth = width;
    this.liveOverlayHeight = height;
    this.liveAnswerMarkers = markers;
    const previousFrameUrl = this.liveOverlayFrameBlobUrl;
    this.liveOverlayFrameBlobUrl = URL.createObjectURL(frame);
    if (previousFrameUrl) {
      setTimeout(() => URL.revokeObjectURL(previousFrameUrl), 1000);
    }
    requestAnimationFrame(() => this.layoutLiveAnswerMarkers());
  }

  private layoutLiveAnswerMarkers() {
    const image = this.cameraFeed?.nativeElement;
    if (
      !image
      || this.liveOverlayWidth <= 0
      || this.liveOverlayHeight <= 0
      || image.clientWidth <= 0
      || image.clientHeight <= 0
    ) return;

    const containerWidth = image.clientWidth;
    const containerHeight = image.clientHeight;
    const imageRatio = this.liveOverlayWidth / this.liveOverlayHeight;
    const containerRatio = containerWidth / containerHeight;
    let renderedWidth = containerWidth;
    let renderedHeight = containerHeight;
    let offsetX = 0;
    let offsetY = 0;
    if (containerRatio > imageRatio) {
      renderedWidth = containerHeight * imageRatio;
      offsetX = (containerWidth - renderedWidth) / 2;
    } else {
      renderedHeight = containerWidth / imageRatio;
      offsetY = (containerHeight - renderedHeight) / 2;
    }

    this.liveAnswerMarkers = this.liveAnswerMarkers.map(marker => ({
      ...marker,
      left: offsetX + (marker.x / this.liveOverlayWidth) * renderedWidth,
      top: offsetY + (marker.y / this.liveOverlayHeight) * renderedHeight,
    }));
  }

  private clearLiveAnswerOverlay() {
    this.liveAnswerMarkers = [];
    this.liveOverlayWidth = 0;
    this.liveOverlayHeight = 0;
    if (this.liveOverlayFrameBlobUrl) {
      const staleUrl = this.liveOverlayFrameBlobUrl;
      this.liveOverlayFrameBlobUrl = null;
      setTimeout(() => URL.revokeObjectURL(staleUrl), 250);
    }
  }
    
  testStreamConnection() {
    if (!this.cameraBaseUrl) {
      this.showToastMessage('Please enter camera URL first');
      return;
    }
    this.updateCameraUrls();
    this.showToastMessage('Testing camera connection...');
    const cameraBaseUrl = this.cameraBaseUrl;
    const captureUrl = this.cameraCaptureRequestUrl();
    this.http.get(captureUrl, {
      headers: this.cameraRequestHeaders(captureUrl),
      responseType: 'blob'
    }).pipe(timeout(18000)).subscribe({
      next: (blob) => {
        if (this.destroyed || this.cameraBaseUrl !== cameraBaseUrl) return;
        if (!blob.size) {
          this.streamError = true;
          this.cameraHealthMessage = 'The camera returned an empty frame.';
          this.checkCameraHealth();
          return;
        }
        this.markCameraHealthy();
        this.showToastMessage('Camera connected and producing frames.');
        this.updateCameraUrls();
        if (this.isScannerActive && !this.isPolling) this.startStreamPoll();
      },
      error: (error) => {
        if (this.destroyed || this.cameraBaseUrl !== cameraBaseUrl) return;
        console.error('Capture test failed:', error);
        this.noteCameraFrameFailure(this.cameraRequestErrorMessage(error), error);
        this.checkCameraHealth();
      }
    });
  }

  private markCameraHealthy() {
    this.streamError = false;
    this.streamErrorCount = 0;
    this.cameraHealthMessage = '';
    this.clearCameraHealthRetry();
  }

  get cameraConnectionLabel(): string {
    if (this.streamError) return this.cameraFrameVisible ? 'Reconnecting' : 'Connecting';
    return this.cameraFrameVisible ? 'Scanning' : 'Connecting';
  }

  private scheduleStartupDiscovery(): void {
    if (this.cameraStartupTimer) clearTimeout(this.cameraStartupTimer);
    this.cameraStartupTimer = setTimeout(() => {
      this.cameraStartupTimer = null;
      if (this.isScannerActive && this.cameraViewActive && !document.hidden && !this.lastCameraFrameAt && !this.isDiscoveringCamera) this.discoverAcadcam(true);
    }, 1500);
  }

  private clearCameraHealthRetry(resetAttempts = true) {
    if (this.cameraHealthRetryTimer) {
      clearTimeout(this.cameraHealthRetryTimer);
      this.cameraHealthRetryTimer = null;
    }
    if (resetAttempts) this.cameraHealthRetryAttempt = 0;
  }

  private scheduleCameraHealthRetry(delayMs?: number, allowInactive = false) {
    if (
      this.destroyed
      || !this.cameraBaseUrl
      || (!allowInactive && !this.isScannerActive)
    ) return;
    // A frame failure must not pull a pending health check forward or postpone
    // it indefinitely. Keep the existing backoff until that check finishes.
    if (this.cameraHealthRetryTimer) return;
    const retryDelay = delayMs ?? Math.min(
      750 * Math.pow(2, Math.min(this.cameraHealthRetryAttempt, 4)),
      this.MAX_STREAM_RETRY_DELAY_MS
    );
    this.cameraHealthRetryAttempt++;
    this.cameraHealthRetryTimer = setTimeout(() => {
      this.cameraHealthRetryTimer = null;
      if (this.destroyed || (!allowInactive && !this.isScannerActive)) return;
      this.checkCameraHealth(true);
    }, retryDelay);
  }

  private checkCameraHealth(silent = false) {
    if (this.destroyed || !this.cameraBaseUrl) return;
    if (this.cameraHealthRequestInFlight) {
      this.scheduleCameraHealthRetry();
      return;
    }
    this.cameraHealthRequestInFlight = true;
    const healthStartedAt = Date.now();
    const cameraBaseUrl = this.cameraBaseUrl.replace(/\/+$/, '');
    const statusUrl = `${cameraBaseUrl}/status`;
    this.http.get<any>(statusUrl, {
      headers: this.cameraRequestHeaders(statusUrl)
    }).pipe(
      timeout(8000),
      finalize(() => { this.cameraHealthRequestInFlight = false; })
    ).subscribe({
      next: (status) => {
        if (this.destroyed || this.cameraBaseUrl.replace(/\/+$/, '') !== cameraBaseUrl) return;
        if (this.lastCameraFrameAt >= healthStartedAt) return;
        const healthy = status?.camera_initialized === true && status?.frame_available !== false;
        if (healthy) {
          this.markCameraHealthy();
          if (!silent) this.showToastMessage('Camera is online and producing frames.');
          this.updateCameraUrls();
          if (this.isScannerActive) {
            this.startStreamPoll();
            if (this.autoScanEnabled && !this.detectionActive) this.startAutoDetection();
          }
          return;
        }

        this.streamError = true;
        this.cameraHealthMessage = status?.hint
          || status?.last_error
          || 'Camera service is reachable, but no recent frame is available.';
        if (!silent) this.showToastMessage(`Camera unavailable: ${this.cameraHealthMessage}`);
        if (this.isScannerActive) {
          if (status?.camera_initialized === false && !status?.recovery_in_progress) this.requestCameraRestart();
          this.scheduleCameraHealthRetry();
        }
      },
      error: () => {
        if (this.destroyed || this.cameraBaseUrl.replace(/\/+$/, '') !== cameraBaseUrl) return;
        if (this.lastCameraFrameAt >= healthStartedAt) return;
        this.streamError = true;
        this.cameraHealthMessage = 'Cannot reach the camera service. Check the URL and Wi-Fi connection.';
        if (!silent) this.showToastMessage(this.cameraHealthMessage);
        if (this.isScannerActive) this.scheduleCameraHealthRetry();
      }
    });
  }

  restartCameraService() {
    this.requestCameraRestart(true);
  }

  private requestCameraRestart(force = false) {
    if (this.cameraRestartInFlight || !this.cameraBaseUrl) return;
    const now = Date.now();
    const cooldownRemaining = this.CAMERA_RESTART_COOLDOWN_MS - (now - this.lastCameraRestartAt);
    if (!force && cooldownRemaining > 0) {
      this.scheduleCameraHealthRetry(Math.max(500, cooldownRemaining));
      return;
    }
    this.lastCameraRestartAt = now;
    this.cameraRestartInFlight = true;
    const cameraBaseUrl = this.cameraBaseUrl.replace(/\/+$/, '');
    const restartUrl = `${cameraBaseUrl}/restart-camera`;
    this.http.post<any>(restartUrl, {}, {
      headers: this.cameraRequestHeaders(restartUrl)
    }).pipe(timeout(8000)).subscribe({
      next: (result) => {
        this.cameraRestartInFlight = false;
        if (this.destroyed || this.cameraBaseUrl.replace(/\/+$/, '') !== cameraBaseUrl) return;
        if (!result?.success) {
          this.cameraHealthMessage = result?.message || 'Camera restart did not complete.';
          this.scheduleCameraHealthRetry(1000, !this.isScannerActive);
          return;
        }
        // Camera drivers often need a short warm-up after the restart endpoint
        // returns. Do not claim recovery until /status or /capture proves it.
        this.streamError = true;
        this.cameraHealthMessage = 'Camera restarted; waiting for a fresh frame...';
        this.scheduleCameraHealthRetry(750, !this.isScannerActive);
      },
      error: () => {
        this.cameraRestartInFlight = false;
        if (this.destroyed || this.cameraBaseUrl.replace(/\/+$/, '') !== cameraBaseUrl) return;
        this.cameraHealthMessage = 'Camera restart request failed; reconnecting...';
        this.scheduleCameraHealthRetry(1000, !this.isScannerActive);
      }
    });
  }

  ngOnDestroy() {
    this.destroyed = true;
    this.cameraViewActive = false;
    this.cameraRequestedActive = false;
    this.closeRealtimeGuide();
    this.stopDeviceCamera();
    this.stopExternalCameraSession();
    this.clearAutoScanCooldown();
    this.isProcessing = false;
  }

  @HostListener('window:resize')
  onScannerViewportResize() {
    if (this.liveAnswerMarkers.length > 0) {
      requestAnimationFrame(() => this.layoutLiveAnswerMarkers());
    }
    if (this.guideActive) requestAnimationFrame(() => this.refreshGuideTarget());
  }

  ionViewWillLeave() {
    this.http.setCameraActive(false);
    // Pause network work while this cached page is hidden, but preserve the
    // user's camera intent. Returning resumes the same live session; only
    // the Stop Camera control turns it off.
    this.cameraViewActive = false;
    this.closeRealtimeGuide();
    this.stopDeviceCamera();
    this.stopAutoDetection();
    this.stopStreamPoll();
    this.clearCameraHealthRetry();
  }

  @HostListener('document:visibilitychange')
  onCameraVisibilityChanged(): void {
    if (!document.hidden && this.synchronizeScannerMode()) return;
    if (document.hidden) {
      this.http.setCameraActive(false);
      this.stopAutoDetection();
      this.stopStreamPoll();
      this.clearCameraHealthRetry();
    } else if (this.cameraRequestedActive && this.cameraViewActive && this.isScannerActive && !this.destroyed) {
      this.http.setCameraActive(true);
      this.updateCameraUrls();
      this.startStreamPoll();
      if (this.autoScanEnabled) this.startAutoDetection();
    }
  }

  ionViewWillEnter() {
    this.cameraViewActive = true;
    if (this.synchronizeScannerMode()) return;
    if (this.cameraRequestedActive && this.isScannerActive && this.cameraBaseUrl) {
      this.http.setCameraActive(true);
      this.updateCameraUrls();
      this.startStreamPoll();
      if (this.autoScanEnabled) this.startAutoDetection();
    }
    if (this.isOfflineMode) {
      this.loadReferenceData();
      if (this.selectedClassroomId) {
        void this.loadStudentsForClassroom(Number(this.selectedClassroomId));
      }
    }
  }

  loadReferenceData() {
    const offline = this.isOfflineMode;
    this.answerKeyService.getAnswerKeys().subscribe({
      next: (keys) => {
        if (offline !== this.isOfflineMode) return;
        this.answerKeys = keys;
      },
      error: (err) => console.error('Failed to load answer keys:', err)
    });

    this.classroomService.getClassrooms().subscribe({
      next: (classrooms) => {
        if (offline !== this.isOfflineMode) return;
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
    this.loadedStudentClassroomId = null;
    if (!this.selectedClassroomId) {
      this.studentsLoaded = true;
      return Promise.resolve();
    }
    this.selectedClassroomId = Number(this.selectedClassroomId);
    return this.loadStudentsForClassroom(this.selectedClassroomId);
  }

  private loadStudentsForClassroom(classroomId: number): Promise<void> {
    const offline = this.isOfflineMode;
    this.studentsLoaded = false;
    return new Promise<void>((resolve) => {
      this.studentService.getStudentsByClassroom(Number(classroomId)).subscribe({
        next: (students: any[]) => {
          if (offline !== this.isOfflineMode) { resolve(); return; }
          this.students = students;
          this.loadedStudentClassroomId = Number(classroomId);
          this.studentsLoaded = true;
          resolve();
        },
        error: (err) => {
          console.error('Failed to load students:', err);
          this.showToastMessage('Failed to load students for selected classroom');
          this.loadedStudentClassroomId = Number(classroomId);
          this.studentsLoaded = true;
          resolve();
        }
      });
    });
  }

  loadScanHistory() {
    const offline = this.isOfflineMode;
    this.scanService.getScans({ limit: 10 }).subscribe({
      next: (response: any) => {
        if (offline !== this.isOfflineMode) return;
        this.scanHistory = response.scans || [];
      },
      error: (err) => console.error('Failed to load scan history:', err)
    });
  }

  loadStats() {
    const offline = this.isOfflineMode;
    this.scanService.getScans({ limit: 100 }).subscribe({
      next: (response: any) => {
        if (offline !== this.isOfflineMode) return;
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
    if (!sequence) {
      // Sequence OCR may be absent for one moving frame. Keep the student
      // already proven on this physical sheet; the verified sheet-removal
      // boundary clears it before the next student can be scanned.
      return;
    }

    const standaloneMatch = sequence.trim().match(/^0*(\d{1,2})$/);
    const legacyMatch = sequence.match(/^(\d{2})-(\d{2})-(\d{4})(?:-(\d+))?$/);
    const seqNumberStr = standaloneMatch?.[1] || legacyMatch?.[4] || null;
    const seqNumber = seqNumberStr ? parseInt(seqNumberStr, 10) : null;
    if (!seqNumber || seqNumber > 60) {
      return;
    }

     // The manually selected answer key selects the classroom; the handwritten
     // one- or two-digit sequence selects the student within it.
     if ((!this.selectedStudentId || this.selectedStudentId === this.autoSelectedStudentId) && seqNumber) {
       let classroomId = this.selectedClassroomId;
       if (!classroomId) {
         // A stale class roster must not prevent an automatic sequence lookup.
         try { this.students = await firstValueFrom(this.studentService.getStudents()); }
         catch { if (!this.students.length) this.students = []; }
       }
       if (!classroomId) {
         const globalMatches = this.students.filter(student => Number(student.sequentialNumber) === seqNumber);
         if (globalMatches.length === 1 && Number(globalMatches[0].classroomId) > 0) {
           this.selectedClassroomId = Number(globalMatches[0].classroomId);
           await this.onClassroomChange();
           classroomId = this.selectedClassroomId;
         }
       }
       const alreadyHasClassroomStudents = classroomId
         ? this.students.some(student => Number(student.classroomId) === Number(classroomId))
         : this.students.length > 0;
       if (classroomId && this.loadedStudentClassroomId !== Number(classroomId) && !alreadyHasClassroomStudents) {
         await this.loadStudentsForClassroom(Number(classroomId));
       }
       const studentsInClassroom = classroomId
         ? this.students.filter(s => Number(s.classroomId) === Number(classroomId))
         : this.students;

       const matches = studentsInClassroom.filter(s => Number(s.sequentialNumber) === seqNumber);
       if (matches.length === 1) {
         this.selectedStudentId = matches[0].id;
         this.autoSelectedStudentId = matches[0].id;
         this.studentSequenceReviewRequired = false;
       } else if (this.autoSelectedStudentId && this.selectedStudentId === this.autoSelectedStudentId) {
         this.selectedStudentId = null;
         this.autoSelectedStudentId = null;
       }
     }
   }

  private resolveOfflineSequence(result: OfflineOmrResult, now = Date.now()): string | null {
    if (result.sheetPresence === 'absent') {
      this.clearOfflineSequenceCandidate();
      return null;
    }
    // Student identity comes from the separately boxed footer and remains
    // readable even while answer-row registration is unresolved.
    const strict = String(result.sequence || '').replace(/^0+/, '');
    if (/^\d{1,2}$/.test(strict) && Number(strict) > 0 && Number(strict) <= 60
      && result.geometryVerified === true) {
      this.offlineSequenceCandidate = '';
      this.offlineSequenceCandidateFrames = 0;
      this.offlineSequenceCandidateFingerprint = '';
      return strict;
    }
    const candidate = String(result.sequenceCandidate || strict || '').replace(/^0+/, '');
    const confidence = Number(result.sequenceConfidence || (strict ? 100 : 0));
    if (!/^\d{1,2}$/.test(candidate) || Number(candidate) < 1 || Number(candidate) > 60
      || confidence < this.MIN_SEQUENCE_CANDIDATE_CONFIDENCE) {
      if (result.sheetPresence === 'absent') this.clearOfflineSequenceCandidate();
      return null;
    }
    const recent = now - this.offlineSequenceCandidateAt <= 5000;
    // The Windows/browser OMR fallback has no native fingerprint. Requiring
    // one here made a perfectly repeatable digit candidate remain at 1/2
    // forever. Two consecutive registered reads without fingerprints are
    // still strong same-sheet evidence; any empty frame clears this state.
    const bothWithoutFingerprint = !result.sheetFingerprint
      && !this.offlineSequenceCandidateFingerprint;
    const sameFingerprint = bothWithoutFingerprint || (
      !!result.sheetFingerprint
      && !!this.offlineSequenceCandidateFingerprint
      && this.fingerprintDistance(result.sheetFingerprint, this.offlineSequenceCandidateFingerprint)
        <= this.SAME_SHEET_FINGERPRINT_DISTANCE
    );
    if (recent && sameFingerprint && candidate === this.offlineSequenceCandidate) {
      this.offlineSequenceCandidateFrames++;
    } else {
      this.offlineSequenceCandidate = candidate;
      this.offlineSequenceCandidateFrames = 1;
    }
    this.offlineSequenceCandidateFingerprint = result.sheetFingerprint || '';
    this.offlineSequenceCandidateAt = now;
    return this.offlineSequenceCandidateFrames >= this.REQUIRED_SEQUENCE_CANDIDATE_FRAMES
      ? candidate
      : null;
  }

  private clearOfflineSequenceCandidate(): void {
    this.offlineSequenceCandidate = '';
    this.offlineSequenceCandidateFrames = 0;
    this.offlineSequenceCandidateFingerprint = '';
    this.offlineSequenceCandidateAt = 0;
  }

  onStudentSelectionChange() {
    // A user-selected student is an intentional lock for manual/batch work.
    // Only IDs populated by OCR/sequence matching are cleared automatically.
    this.autoSelectedStudentId = null;
    if (this.selectedStudentId) this.studentSequenceReviewRequired = false;
  }

  studentSequenceReviewRequired = false;

  private pauseForStudentSequenceReview(message: string) {
    this.studentSequenceReviewRequired = true;
    if (this.autoSelectedStudentId && this.selectedStudentId === this.autoSelectedStudentId) {
      this.selectedStudentId = null;
    }
    this.autoSelectedStudentId = null;
    this.pendingCapturedSignature = '';
    this.pendingCapturedFingerprint = '';
    this.pendingCapturedStudentId = null;
    this.pendingCapturedSequence = '';
    this.autoCapturedScan = false;
    this.liveDetectionStatus = 'scanning';
    this.liveQualityMessage = message;
    this.showToastMessage(message);
  }

   openCameraMode() {
    this.scanMode = 'camera';
  }

  openUploadMode() {
    this.scanMode = 'upload';
  }

  onSegmentChange(event: any) {
    this.scanMode = event.detail.value;
    if (this.scanMode !== 'upload') this.stopDeviceCamera();
    if (this.guideActive) requestAnimationFrame(() => this.refreshGuideTarget(true));
  }

  async onAnswerKeyChange() {
    this.liveResolvedRows = 0;
    this.offlineNeedsDetailFrame = false;
    // A homography tracked for one printed form must not be reused after the
    // operator selects another form/template.
    this.resetTrackingSession();
    const selectedKey = this.answerKeys.find(item => item.id === this.selectedAnswerKeyId);
    const keyClassroomId = Number(selectedKey?.classroomId || 0) || null;
    if (keyClassroomId) {
      if (keyClassroomId !== Number(this.selectedClassroomId || 0)) {
        this.selectedClassroomId = keyClassroomId;
        await this.onClassroomChange();
      } else if (this.loadedStudentClassroomId !== keyClassroomId) {
        await this.loadStudentsForClassroom(keyClassroomId);
      }
    }
    if (this.isOfflineMode) {
      const key = selectedKey;
      this.offlineAnswers = Array(Number(key?.numQuestions || 50)).fill('');
      this.offlineConfidences = Array(this.offlineAnswers.length).fill(0);
      this.offlineMarkedLetters = Array.from({ length: this.offlineAnswers.length }, () => []);
      this.offlineReviewed = Array(this.offlineAnswers.length).fill(false);
      this.offlineGradeable = false;
      void this.detectOfflineAnswers();
    }
  }

  async detectOfflineAnswers() {
    if (!this.isOfflineMode || !this.selectedFile || !this.selectedAnswerKeyId) return;
    const key = this.answerKeys.find(item => item.id === this.selectedAnswerKeyId);
    const questionCount = Number(key?.numQuestions || 0);
    if (!questionCount) return;
    const run = ++this.offlineDetectionRun;
    this.offlineDetectionStatus = 'detecting';
    this.offlineDetectionMessage = 'Registering the sheet and reading bubbles on this device...';
    try {
      const file = this.selectedFile;
      const fingerprint = this.offlineFingerprint || await this.fingerprintFile(file);
      if (run !== this.offlineDetectionRun || !this.isOfflineMode) return;
      this.offlineFingerprint = fingerprint;
      const result = await this.detectOfflineFrame(file, questionCount);
      if (run !== this.offlineDetectionRun || !this.isOfflineMode) return;
      this.applyOfflineDetectionResult(result, questionCount);
      await this.autoPickAnswerKeyAndStudent(result.sequence || null);
    } catch (error: any) {
      if (run !== this.offlineDetectionRun || !this.isOfflineMode) return;
      this.offlineGradeable = false;
      this.offlineReviewed = Array(this.offlineAnswers.length).fill(false);
      this.offlineDetectionStatus = 'error';
      this.offlineDetectionMessage = error?.message || 'Offline bubble detection failed. Enter the answers manually or retake the photo.';
    }
  }

  async saveOfflineManualGrade(sourceFile: File | null = this.selectedFile, automatedLive = false): Promise<boolean> {
    if (!this.isOfflineMode || !sourceFile) return false;
    if (!this.selectedClassroomId || !this.selectedStudentId || !this.selectedAnswerKeyId) {
      this.showToastMessage('Select an answer key, classroom, and student first');
      return false;
    }
    const key = this.answerKeys.find(item => item.id === this.selectedAnswerKeyId);
    const totalQuestions = Number(key?.numQuestions || 0);
    if (!totalQuestions || this.offlineAnswers.length !== totalQuestions) {
      this.showToastMessage('Reload the selected answer key and try again');
      return false;
    }
    if (!this.offlineGradeable && !this.offlineAnswers.every(answer => /^[A-D]$/.test(String(answer || '').toUpperCase()))) {
      this.showToastMessage(`Review and select an answer for all ${totalQuestions} questions`);
      return false;
    }
    if (!this.offlineGradeable && !this.offlineReviewed.every(Boolean)) {
      this.showToastMessage('The grid alignment was uncertain. Review every highlighted answer before grading');
      return false;
    }
    let savedSuccessfully = false;
    this.isProcessing = true;
    try {
      const response = await this.scanService.saveOfflineManualGrade({
        filename: sourceFile.name,
        classroomId: this.selectedClassroomId,
        answerKeyId: this.selectedAnswerKeyId,
        studentId: this.selectedStudentId,
        answers: this.offlineAnswers,
        confidences: this.offlineConfidences,
        markedLetters: this.offlineMarkedLetters,
        verifiedOmr: this.offlineGradeable,
        fingerprint: this.offlineFingerprint,
        processingMs: this.offlineProcessingMs,
        overallConfidence: this.currentOfflineConfidence,
        anchorMethod: this.offlineAnchorMethod,
        qrData: this.offlineQrData,
      }).toPromise();
      if (!response?.success) throw new Error(response?.message || 'Could not save offline grade');
      savedSuccessfully = true;
      if (!this.isOfflineMode) return true;
      this.currentScan = { ...response.scan, scan_status: 'completed' };
      // A committed grade must not become retryable if reloading its details fails.
      try {
        const saved = await this.scanService.getScan(Number(response.scan.id)).toPromise();
        if (saved?.scan) this.currentScan = { ...saved.scan, scan_status: 'completed' };
      } catch (reloadError) {
        console.warn('Grade saved; details could not be refreshed:', reloadError);
      }
      this.showToastMessage(`Saved locally. Score: ${response.scan.grading?.totalScore || 0}/${totalQuestions}`);
      this.loadScanHistory();
      this.loadStats();
      if (this.autoPrintEnabled && this.currentScan) {
        await this.printOfflineScore(this.currentScan);
      }
    } catch (error: any) {
      this.showToastMessage(error?.message || 'Could not save offline grade');
    } finally {
      this.isProcessing = false;
      if (automatedLive && savedSuccessfully && this.isOfflineMode) {
        this.rememberPendingCapturedSheet();
        this.beginAutoScanCooldown();
        this.resetOfflineDetectionResult();
        this.resumeAutoScanAfterProcessing();
      }
    }
    return savedSuccessfully;
  }

  private async printOfflineScore(scan: any): Promise<void> {
    const totalScore = Number(scan?.examResponse?.total_score ?? scan?.grading?.totalScore ?? 0);
    const totalQuestions = Number(scan?.omrResults?.length || this.getAnswersCount() || 50);
    const scoreText = `${Math.max(0, Math.round(totalScore))}/${Math.max(1, totalQuestions)}`;
    if (this.isStandaloneAndroid) {
      try { await this.printAndroidScore(scan); }
      catch (error: any) { this.showToastMessage(error?.message || 'USB printing failed.'); }
      return;
    }
    try {
      try {
        const directPrint = await firstValueFrom(this.http.post<any>(
          `${this.backendCameraBaseUrl}/print-score`,
          { scoreText, questionResults: savedQuestionResults(scan) }
        ).pipe(timeout(15000)));
        if (directPrint?.success && directPrint?.printedDirectly) {
          this.showToastMessage(`Score ${scoreText} sent to ${directPrint.printerName || 'the default printer'}`);
          return;
        }
      } catch (directPrintError) {
        if (this.autoPrintEnabled) throw directPrintError;
        console.warn('Local Windows direct print unavailable; opening browser print dialog:', directPrintError);
      }
      if (this.autoPrintEnabled) throw new Error('Auto Print failed: the local printer did not accept the print job.');
      const questionResults = savedQuestionResults(scan);
      await this.printScoreInFrame(buildScoreSheetOverlayDataUrl(scoreText, questionResults));
      this.showToastMessage(`Print dialog opened for ${scoreText}`);
    } catch (error: any) {
      console.error('Offline Auto Print failed:', error);
      this.showToastMessage(error?.message || 'Offline Auto Print could not open the device print service');
    }
  }

  onOfflineAnswerChanged(index: number): void {
    this.offlineConfidences[index] = this.offlineAnswers[index] ? 100 : 0;
    this.offlineReviewed[index] = true;
    this.offlineMarkedLetters[index] = this.offlineAnswers[index] ? [this.offlineAnswers[index]] : [];
  }

  get offlineAnswersComplete(): boolean {
    if (!this.offlineAnswers.length) return false;
    if (this.offlineGradeable) {
      return this.offlineMarkedLetters.length === this.offlineAnswers.length;
    }
    return this.offlineAnswers.every(answer => /^[A-D]$/.test(String(answer || '').toUpperCase()))
      && this.offlineReviewed.every(Boolean);
  }

  get currentOfflineConfidence(): number {
    if (!this.offlineConfidences.length) return 0;
    return Math.round(this.offlineConfidences.reduce((sum, value) => sum + Number(value || 0), 0)
      / this.offlineConfidences.length);
  }

  private async fingerprintFile(file: File): Promise<string> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (crypto?.subtle) {
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      return Array.from(digest, value => value.toString(16).padStart(2, '0')).join('');
    }
    let first = 2166136261;
    let second = 2246822519;
    for (const value of bytes) {
      first = Math.imul(first ^ value, 16777619);
      second = Math.imul(second ^ value, 3266489917);
    }
    return `${bytes.length.toString(16)}-${(first >>> 0).toString(16)}-${(second >>> 0).toString(16)}`;
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
    this.toggleRaspberryPiCamera();
  }

  toggleRaspberryPiCamera() {
    if (this.synchronizeScannerMode()) return;
    if (this.isScannerActive) {
      this.cameraRequestedActive = false;
      this.stopExternalCameraSession();
    } else {
      if (this.isProcessing) {
        this.showToastMessage('Wait for the current scan to finish before restarting the camera');
        return;
      }
      if (!this.selectedAnswerKeyId) {
        this.showToastMessage('Select an answer key before starting the scanner');
        return;
      }
      this.cameraViewActive = true;
      this.cameraRequestedActive = true;
      this.cameraSessionGeneration++;
      this.isScannerActive = true;
      this.http.setCameraActive(true);
      this.cameraFrameVisible = false;
      this.lastCameraFrameAt = 0;
      this.capturedImage = null;
      this.streamFrameBlobUrl = null;
      this.streamErrorCount = 0;
      this.streamError = false;

      if (!this.cameraBaseUrl) {
        this.showToastMessage('Please set camera URL first');
        this.cameraRequestedActive = false;
        this.isScannerActive = false;
        this.endTrackingSession();
        return;
      }

      this.beginTrackingSession();
      this.updateCameraUrls();
      console.log('Starting Raspberry Pi camera poll from:', this.cameraCaptureUrl);
      this.startStreamPoll();
      this.scheduleStartupDiscovery();
      if (this.autoScanEnabled) this.startAutoDetection();
    }
  }

  private async detectOfflineFrame(file: File, questionCount: number, options: OfflineOmrOptions = {}): Promise<OfflineOmrResult> {
    return this.offlineOmrService.detect(file, questionCount, options);
  }

  private applyOfflineDetectionResult(result: OfflineOmrResult, questionCount: number): void {
    this.offlineAnswers = result.answers;
    this.offlineConfidences = result.confidences;
    this.offlineGradeable = result.gradeable;
    this.offlineReviewed = Array(result.answers.length).fill(result.gradeable);
    this.offlineMarkedLetters = result.markedLetters || result.answers.map(answer => answer ? [answer] : []);
    this.offlineProcessingMs = result.processingMs;
    this.offlineOverallConfidence = result.overallConfidence;
    this.offlineAnchorMethod = result.anchorMethod;
    // QR content is intentionally ignored. Older QR-format sheets remain
    // scannable, but the code is never used for placement or identity.
    this.offlineQrData = '';
    this.offlineDetectionStatus = 'done';
    const zeroPointRows = this.offlineMarkedLetters.filter(row => row.length !== 1).length;
    this.offlineDetectionMessage = result.gradeable
      ? zeroPointRows > 0
        ? `Verified all ${questionCount} rows in ${result.processingMs} ms. ${zeroPointRows} blank or multi-mark row${zeroPointRows === 1 ? '' : 's'} will score zero.`
        : `Verified all ${questionCount} answers in ${result.processingMs} ms at ${result.overallConfidence}% confidence. Ready to grade.`
      : result.reason
        ? `${result.reason} Review the highlighted rows before grading.`
        : `The complete A-D grid could not be verified. ${Math.max(0, questionCount - result.uncertainCount)}/${questionCount} rows were resolved; review every highlighted row before grading.`;
  }

  private async useOfflineCameraFrame(
    blob: Blob,
    knownResult?: OfflineOmrResult,
    autoCaptured = false
  ): Promise<void> {
    const key = this.answerKeys.find(item => item.id === this.selectedAnswerKeyId);
    const questionCount = Number(key?.numQuestions || 0);
    if (!questionCount) {
      this.showToastMessage('Select an answer key before scanning');
      return;
    }

    const file = new File([blob], `raspberry-pi-${Date.now()}.jpg`, {
      type: blob.type || 'image/jpeg',
      lastModified: Date.now(),
    });
    // This frame came from the persistent Pi session. Keep that session and
    // the camera view active while on-device OMR reads and saves the result.
    this.clearSelection();
    this.selectedFile = file;
    this.previewUrl = URL.createObjectURL(file);
    this.resetOfflineDetectionResult();
    try {
      this.offlineFingerprint = await this.fingerprintFile(file);
    } catch {
      // A fingerprint prevents duplicate local saves but is not required to
      // read or review a camera frame.
      this.offlineFingerprint = '';
    }
    this.isProcessing = false;

    if (knownResult) {
      this.applyOfflineDetectionResult(knownResult, questionCount);
    } else {
      await this.detectOfflineAnswers();
    }

    if (
      (!autoCaptured || this.autoRecordEnabled)
      && this.offlineDetectionStatus === 'done'
      && this.offlineGradeable
      && this.selectedClassroomId
      && this.selectedStudentId
    ) {
      await this.saveOfflineManualGrade(file, true);
    } else {
      this.liveDetectionStatus = 'scanning';
      this.liveQualityMessage = !this.selectedStudentId
        ? 'Read complete. Confirm the student, then scan again.'
        : 'Read needs another frame. Keep the complete sheet steady and scan again.';
      this.showToastMessage(this.liveQualityMessage);
      this.resumeAutoScanAfterProcessing();
    }
  }

  private stopExternalCameraSession() {
    this.http.setCameraActive(false);
    this.cameraFrameVisible = false;
    this.lastCameraFrameAt = 0;
    if (this.cameraStartupTimer) clearTimeout(this.cameraStartupTimer);
    this.cameraStartupTimer = null;
    if (this.autoSelectedStudentId && this.selectedStudentId === this.autoSelectedStudentId) this.selectedStudentId = null;
    this.autoSelectedStudentId = null;
    this.offlineAutoStudentFingerprint = '';
    this.offlineAutoStudentAt = 0;
    this.offlineNeedsDetailFrame = false;
    this.cameraSessionGeneration++;
    this.cameraDiscoveryGeneration++;
    this.isScannerActive = false;
    this.stopAutoDetection();
    this.stopStreamPoll();
    this.clearCameraHealthRetry();
    this.cleanupStream();
    this.clearSharedCameraFrames();
    this.endTrackingSession();
    this.isDiscoveringCamera = false;
    if (this.cameraCaptureInFlight) {
      this.cameraCaptureInFlight = false;
      this.isProcessing = false;
    }
  }

  cleanupStream() {
    this.isPolling = false;
    this.stopStreamPoll();
    if (this.streamFrameBlobUrl && !this.isScannerActive) {
      URL.revokeObjectURL(this.streamFrameBlobUrl);
      this.streamFrameBlobUrl = null;
    }
    this.cameraStreamUrl = '';
    this.streamError = false;
    this.streamErrorCount = 0;
    this.clearSharedCameraFrames();
    this.liveDetection = null;
    this.liveConfidence = 0;
    this.liveResolvedRows = 0;
    this.liveConfidenceColor = 'danger';
    this.liveDetectionStatus = 'idle';
    this.liveQualityMessage = '';
    this.liveDebugMessage = '';
    this.clearLiveAnswerOverlay();
    this.recentLiveQualities = [];
    this.examSheetDetection = null;
    this.examSheetConfidence = 0;
    this.examSheetConfidenceColor = 'danger';
    this.examSheetRecommendation = '';
  }

  stopStreamPoll() {
    this.streamPollGeneration++;
    if (this.streamPollTimer) {
      clearTimeout(this.streamPollTimer);
      this.streamPollTimer = null;
    }
    if (this.streamRequestSubscription) {
      this.streamRequestSubscription.unsubscribe();
      this.streamRequestSubscription = null;
    }
    this.isPolling = false;
  }

  private scheduleNextPoll(delayMs: number, generation = this.streamPollGeneration) {
    if (generation !== this.streamPollGeneration || !this.isScannerActive) return;
    if (this.streamPollTimer) clearTimeout(this.streamPollTimer);
    this.isPolling = true;
    this.streamPollTimer = setTimeout(() => {
      this.streamPollTimer = null;
      if (!this.isScannerActive || generation !== this.streamPollGeneration) {
        this.isPolling = false;
        return;
      }
      this.pollFrame(generation);
    }, delayMs);
  }

  private startStreamPoll() {
    if (this.cameraViewActive === false || document.hidden) return;
    // A health callback must not cancel a capture which is already loading.
    if (this.streamRequestSubscription && !this.streamRequestSubscription.closed) return;
    this.stopStreamPoll();
    if (!this.isScannerActive || !this.cameraCaptureUrl || this.destroyed) return;
    const generation = this.streamPollGeneration;
    this.isPolling = true;
    this.pollFrame(generation);
  }

  private pollFrame(generation = this.streamPollGeneration) {
    if (
      !this.isScannerActive
      || !this.cameraCaptureUrl
      || generation !== this.streamPollGeneration
      || this.destroyed
      || this.cameraViewActive === false
      || document.hidden
    ) {
      this.isPolling = false;
      return;
    }

    // Reuse the same Raspberry Pi capture Blob for the preview and the next
    // OMR request. This avoids a second simultaneous camera read, JPEG encode,
    // and network transfer while leaving the existing Pi service unchanged.
    const previewOnly = this.usesDirectPiConnection && !this.lastCameraFrameAt
      && !(this.autoScanEnabled && this.selectedAnswerKeyId);
    const requestStartedAt = Date.now();
    const url = this.cameraCaptureRequestUrl(previewOnly);
    let requestSubscription: Subscription | undefined;
    requestSubscription = this.http.get(url, {
      headers: this.cameraRequestHeaders(url),
      responseType: 'blob'
    }).pipe(
      // The native request has its own total deadline and supports cancellation.
      timeout(18000)
    ).subscribe({
      next: (blob) => {
        if (this.streamRequestSubscription === requestSubscription) {
          this.streamRequestSubscription = null;
        }
        if (!this.isScannerActive || generation !== this.streamPollGeneration || this.destroyed) return;

        if (!blob || blob.size === 0) {
          this.noteCameraFrameFailure('Camera is connected but returned an empty frame.');
          this.scheduleNextPoll(this.getStreamRetryDelay(), generation);
          return;
        }

        this.markCameraHealthy();
        this.lastCameraFrameAt = Date.now();
        if (this.cameraStartupTimer) clearTimeout(this.cameraStartupTimer);
        this.cameraStartupTimer = null;
        if (this.usesDirectPiConnection) localStorage.setItem('scanner.workingPiUrl', this.cameraBaseUrl);
        if (!previewOnly) this.rememberOmrFrame(blob);

        if (!this.streamFrameBlobUrl) {
          const newUrl = URL.createObjectURL(blob);
          this.streamFrameBlobUrl = newUrl;
        } else {
          const prev = this.streamFrameBlobUrl;
          const newUrl = URL.createObjectURL(blob);
          this.streamFrameBlobUrl = newUrl;
          // Give the <img> element time to switch sources before revoking the
          // previous object URL; immediate revocation can emit a false stream
          // error while the browser is still decoding it.
          setTimeout(() => URL.revokeObjectURL(prev), 1000);
        }
        this.scheduleNextPoll(
          previewOnly ? 0 : this.isOfflineMode ? Math.max(80, 300 - (Date.now() - requestStartedAt)) : this.POLL_INTERVAL_MS,
          generation
        );
      },
      error: (err) => {
        if (this.streamRequestSubscription === requestSubscription) {
          this.streamRequestSubscription = null;
        }
        if (
          !this.isScannerActive
          || generation !== this.streamPollGeneration
          || this.destroyed
        ) return;
        this.noteCameraFrameFailure(
          this.cameraRequestErrorMessage(err),
          err
        );
        this.scheduleNextPoll(this.getStreamRetryDelay(), generation);
      }
    });
    this.streamRequestSubscription = requestSubscription.closed ? null : requestSubscription;
  }

  private getStreamRetryDelay() {
    const baseDelay = this.isOfflineMode
      ? this.OFFLINE_POLL_INTERVAL_MS
      : this.POLL_INTERVAL_MS;
    return Math.min(
      baseDelay * Math.pow(2, Math.min(Math.max(0, this.streamErrorCount - 1), 5)),
      this.MAX_STREAM_RETRY_DELAY_MS
    );
  }

  private noteCameraFrameFailure(message: string, error?: any) {
    this.streamErrorCount++;
    const transientTransportFailure = !!error && (
      error?.name === 'TimeoutError'
      || String(error?.message || '').toLowerCase().includes('timeout')
      || [0, 408, 409, 423, 429, 503, 504].includes(Number(error?.status))
    );
    const confirmedDisconnect = !this.cameraFrameVisible || !transientTransportFailure
      || this.streamErrorCount >= this.TRANSIENT_STREAM_ERROR_LIMIT;
    this.streamError = confirmedDisconnect;
    this.cameraHealthMessage = confirmedDisconnect
      ? message
      : 'Camera response delayed; retrying automatically.';
    // A short delay must not erase matching answers or queue another native job.
    if (!confirmedDisconnect) {
      this.liveDetectionStatus = 'scanning';
      this.liveQualityMessage = 'Camera response delayed; retrying automatically.';
      return;
    }
    this.autoDetectionGeneration++;
    this.autoDetectionInFlight = false;
    this.clearSharedCameraFrames();
    this.clearLiveAnswerOverlay();
    // Keep the last successfully decoded frame visible while reconnecting.
    // The retry loops continue until the user presses Stop Camera.
    this.liveDetection = null;
    this.liveConfidence = 0;
    this.liveResolvedRows = 0;
    this.liveConfidenceColor = 'danger';
    this.liveDetectionStatus = confirmedDisconnect ? 'reject' : 'scanning';
    this.liveQualityMessage = confirmedDisconnect
      ? message
      : 'Camera response delayed — keeping the last preview while retrying.';
    this.liveDebugMessage = '';
    this.recentLiveQualities = [];
    this.stableDetectionSignature = '';
    this.stableDetectionFrames = 0;
    this.noSheetFrames = 0;
    this.replacementSheetFingerprint = '';
    this.replacementSheetFrames = 0;
    this.clearOfflineSequenceCandidate();
    this.examSheetDetection = null;
    this.examSheetConfidence = 0;
    this.examSheetConfidenceColor = 'danger';
    this.examSheetRecommendation = '';
    if (this.streamErrorCount >= this.MAX_STREAM_ERRORS) {
      const now = Date.now();
      if (now - this.lastCameraErrorToastAt >= 10000) {
        this.lastCameraErrorToastAt = now;
        this.showToastMessage(message);
      }
      this.scheduleCameraHealthRetry();
    }
    if (!this.isDiscoveringCamera && (!this.lastCameraDiscoveryAt || Date.now() - this.lastCameraDiscoveryAt >= 15000)) {
      this.discoverAcadcam(true);
    }
    if (error) console.warn('Camera frame request failed:', error);
  }

  private cameraRequestErrorMessage(error: any): string {
    const status = Number(error?.status);
    const timedOut = error?.name === 'TimeoutError'
      || String(error?.message || '').toLowerCase().includes('timeout');

    if (timedOut || status === 408 || status === 504) {
      return 'The camera took too long to respond. Check its connection; AcadCheck will keep retrying.';
    }
    if (status === 0) {
      return 'Cannot reach the camera. Make sure it is powered on and connected to the same Wi-Fi network.';
    }
    if (status === 401 || status === 403) {
      return this.isOfflineMode && !this.usesDirectPiConnection
        ? 'The local camera session could not be renewed. Use Detect Camera to reconnect.'
        : 'The camera service rejected the request. Check its access settings.';
    }
    if (status === 404) {
      return 'The camera capture service was not found. Check the camera address in settings.';
    }
    if (status === 409 || status === 423 || status === 429) {
      return 'The camera is busy. AcadCheck will try again automatically.';
    }
    if (status === 503) {
      return 'The camera is temporarily unavailable. AcadCheck will retry; check the Pi address and local Wi-Fi connection.';
    }
    if (status >= 500) {
      return 'The camera service encountered a problem. Restart the camera device and try again.';
    }
    return error?.code === 'CAMERA_CONNECTION' ? error.message
      : 'The camera image could not be loaded. Check the connection and try again.';
  }

  private detectionRequestErrorMessage(error: any): string {
    const status = Number(error?.status);
    const timedOut = error?.name === 'TimeoutError'
      || String(error?.message || '').toLowerCase().includes('timeout');

    if (timedOut || status === 408 || status === 504) {
      return 'Scanning took too long. Keep the sheet still while AcadCheck tries again.';
    }
    if (status === 0) {
      return 'The scanning service is unavailable. Check that the AcadCheck server is running.';
    }
    if (status === 401 || status === 403) {
      return 'Your session cannot use the scanning service. Sign in again and retry.';
    }
    if (status === 413) {
      return 'The camera image is too large to scan. Lower the camera resolution and try again.';
    }
    if (status === 422) {
      return 'The camera image could not be analyzed. Reposition the sheet and try again.';
    }
    if (status >= 500) {
      return 'The scanning service encountered a problem. Please try again in a moment.';
    }
    return 'AcadCheck could not analyze this camera image. Please try again.';
  }

  private scanFailureSummary(stage: string | undefined): string {
    switch (stage) {
      case 'mark-classification':
        return 'Some answer marks could not be read clearly';
      case 'template-registration':
      case 'qr-grid-phase-verification':
      case 'row-column-estimation':
      case 'qr-grid-consensus':
        return 'The answer sheet could not be aligned reliably';
      case 'answer-key':
      case 'answer-key-resolution':
        return 'The answer key could not be verified';
      default:
        return 'The sheet could not be graded safely';
    }
  }

  onAutoScanChange(event: any) {
    this.autoScanEnabled = event.detail.checked;
    this.liveDebugMessage = '';
    if (this.isScannerActive && this.autoScanEnabled) {
      this.startAutoDetection();
    } else if (!this.autoScanEnabled) {
      this.stopAutoDetection();
      this.clearAutoScanCooldown();
      this.noSheetFrames = 0;
      this.replacementSheetFingerprint = '';
      this.replacementSheetFrames = 0;
      this.liveDetectionStatus = 'idle';
      this.liveQualityMessage = '';
      this.liveConfidence = 0;
      this.liveResolvedRows = 0;
      this.clearLiveAnswerOverlay();
      this.recentLiveQualities = [];
    }
  }

  captureImage() {
    if (this.synchronizeScannerMode()) return;
    this.studentSequenceReviewRequired = false;
    if (!this.cameraCaptureUrl) {
      this.showToastMessage('Camera URL missing — check URL field');
      this.isProcessing = false;
      return;
    }

    if (!this.isScannerActive) {
      this.showToastMessage('Camera is not active');
      this.isProcessing = false;
      return;
    }

    // If Auto Scan remains enabled, a successful manual capture also consumes
    // the page currently under the camera. Preserve the latest live identity
    // so resuming cannot immediately grade that same page a second time.
    this.autoCapturedScan = this.autoScanEnabled;
    if (this.autoCapturedScan) {
      const markedRows = Array.isArray(this.liveDetection?.markedLetters)
        ? this.liveDetection.markedLetters
        : [];
      this.pendingCapturedSignature = markedRows
        .map((row: string[]) => Array.isArray(row) && row.length ? row.join('') : '-')
        .join('');
      this.pendingCapturedFingerprint = String(this.liveDetection?.details?.sheetFingerprint || '');
      this.pendingCapturedStudentId = this.selectedStudentId;
      this.pendingCapturedSequence = String(this.liveDetection?.sequence || '');
    } else {
      this.pendingCapturedSignature = '';
      this.pendingCapturedFingerprint = '';
      this.pendingCapturedStudentId = null;
      this.pendingCapturedSequence = '';
    }
    const captureSession = this.cameraSessionGeneration;
    this.cameraCaptureInFlight = true;
    this.isProcessing = true;
    this.stopAutoDetection();
    this.stopStreamPoll();

    const captureUrl = this.cameraCaptureRequestUrl();
    this.showToastMessage('Capturing image...');
    console.log('Starting capture from:', captureUrl);

    this.http.get(captureUrl, {
      headers: this.cameraRequestHeaders(captureUrl),
      responseType: 'blob'
    }).pipe(
      timeout(18000)
    ).subscribe({
      next: async (blob) => {
        if (
          captureSession !== this.cameraSessionGeneration
          || !this.isScannerActive
          || this.destroyed
        ) return;
        if (!blob || blob.size === 0) {
          console.warn('Empty image received from camera');
          this.recoverLiveCameraAfterCaptureFailure(
            'Camera returned an empty image. Reconnecting...',
            captureSession
          );
          return;
        }

        console.log('Image captured successfully, size:', blob.size);

        if (this.isOfflineMode) {
          this.cameraCaptureInFlight = false;
          await this.useOfflineCameraFrame(blob);
          return;
        }

        const reader = new FileReader();
        reader.onload = () => {
          if (
            captureSession !== this.cameraSessionGeneration
            || !this.isScannerActive
            || this.destroyed
          ) return;
          const base64data = reader.result as string;
          console.log('Image converted to base64, length:', base64data.length);
          this.showToastMessage('Processing captured image...');
          // Preserve the untouched camera frame. The backend's adaptive OMR
          // uses the paper edges to normalize perspective; browser-side
          // thresholding/cropping destroys that geometry on off-centre pages.
          this.capturedImage = base64data;
          this.cameraCaptureInFlight = false;
          // Keep the camera mounted with its last preview while grading.
          // Polling and detection resume after processing completes.
          this.showToastMessage('Image captured! Processing scan...');
          setTimeout(() => this.processCapturedImage(), 50);
        };
        reader.onerror = (event) => {
          console.error('Failed to read captured image:', event);
          this.recoverLiveCameraAfterCaptureFailure(
            'Could not read the camera image. Live view resumed.',
            captureSession
          );
        };
        reader.readAsDataURL(blob);
      },
      error: (err) => {
        if (captureSession !== this.cameraSessionGeneration || this.destroyed) return;
        console.error('Error capturing image from camera:', err);
        this.recoverLiveCameraAfterCaptureFailure(
          'Capture failed. Reconnecting to the camera...',
          captureSession,
          err
        );
      }
    });
  }

  private recoverLiveCameraAfterCaptureFailure(message: string, captureSession: number, error?: any) {
    if (
      captureSession !== this.cameraSessionGeneration
      || !this.isScannerActive
      || this.destroyed
    ) return;
    this.isProcessing = false;
    this.cameraCaptureInFlight = false;
    this.autoCapturedScan = false;
    this.pendingCapturedSignature = '';
    this.pendingCapturedFingerprint = '';
    this.pendingCapturedStudentId = null;
    this.pendingCapturedSequence = '';
    this.noteCameraFrameFailure(message, error);
    this.showToastMessage(message);
    this.updateCameraUrls();
    this.startStreamPoll();
    if (this.autoScanEnabled) this.startAutoDetection();
  }

  startAutoDetection() {
    if (!this.cameraCaptureUrl) {
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
    void this.performAutoDetection();
    this.autoCaptureTimer = setInterval(() => {
      if (this.isScannerActive && this.autoScanEnabled && !this.isProcessing && !this.capturedImage && !this.autoDetectionInFlight) {
        void this.performAutoDetection();
      }
    }, this.isOfflineMode ? this.OFFLINE_DETECTION_INTERVAL_MS : this.DETECTION_INTERVAL_MS);
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
    this.autoDetectionGeneration++;
    this.detectionActive = false;
    if (this.freshFrameDetectionTimer != null) {
      clearTimeout(this.freshFrameDetectionTimer);
      this.freshFrameDetectionTimer = null;
    }
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
      localStorage.setItem(this.automationPreferenceKey('autoPrint'), 'false');
    }
    localStorage.setItem(this.automationPreferenceKey('autoRecord'), String(this.autoRecordEnabled));
  }

  onAutoPrintChange(event: any) {
    this.autoPrintEnabled = !!event.detail.checked;
    if (this.autoPrintEnabled) {
      this.autoRecordEnabled = true;
      localStorage.setItem(this.automationPreferenceKey('autoRecord'), 'true');
    }
    localStorage.setItem(this.automationPreferenceKey('autoPrint'), String(this.autoPrintEnabled));
  }

  private automationPreferenceKey(name: 'autoRecord' | 'autoPrint'): string {
    return this.isOfflineMode ? `scanner.offline.${name}` : `scanner.${name}`;
  }

  /**
    * Auto-scan: Capture frame and run real-time OMR detection
    * If confidence is high enough, automatically grade and save result
    */
  private async performAutoDetection() {
    if (this.synchronizeScannerMode()) return;
    const now = Date.now();
    if (
      this.autoDetectionInFlight
      || this.liveDetectionBusy
      || (this.isOfflineMode && this.nativeDetectionBusy)
      || now - this.lastProcessedTime < this.DEBOUNCE_MS
      || !this.detectionActive
      || !this.isScannerActive
      || !this.autoScanEnabled
      || this.isProcessing
      || !!this.capturedImage
      || this.destroyed
      || this.cameraViewActive === false
      || document.hidden
      || !this.selectedAnswerKeyId
    ) return;
    const detectionGeneration = this.autoDetectionGeneration;
    this.autoDetectionInFlight = true;
    this.liveDetectionBusy = true;

    try {
      const captureBlob = this.freshUnprocessedOmrFrame();
      if (!captureBlob) {
        // Preview owns camera reads, including retry backoff. Detection must
        // wait for its next frame instead of retrying /capture every 300 ms.
        this.autoDetectionInFlight = false;
        if (!this.isPolling && !this.streamRequestSubscription) this.startStreamPoll();
        return;
      }
      if (!this.isCurrentAutoDetection(detectionGeneration)) return;
      if (!captureBlob || captureBlob.size === 0) {
        this.noteCameraFrameFailure('Auto-scan camera frame was empty; retrying...');
        if (detectionGeneration === this.autoDetectionGeneration) {
          this.autoDetectionInFlight = false;
        }
        return;
      }
      this.lastAutoDetectionBlob = captureBlob;
      this.markCameraHealthy();

      if (this.isOfflineMode) {
        await this.performOfflineLiveDetection(captureBlob, detectionGeneration);
        return;
      }

      // Decode the camera Blob through an object URL. FileReader previously
      // converted the full-resolution JPEG to base64 before the browser
      // decoded, resized, and encoded it again, adding one large allocation
      // and copy to every detection cycle.
      const sourceFrameUrl = URL.createObjectURL(captureBlob);
      await (async () => {
        // Normalize the existing Pi capture once in the browser. The verified
        // image and saved token still describe this exact source frame.
        try {
            if (!this.isCurrentAutoDetection(detectionGeneration)) return;
            const liveFrame = await this.preprocessImage(sourceFrameUrl, this.offlineNeedsDetailFrame ? 1920 : 1440);
            if (!this.isCurrentAutoDetection(detectionGeneration)) return;
            const base64Image = liveFrame.split(',')[1];
            const answerKeyObj = this.answerKeys.find(k => k.id === this.selectedAnswerKeyId) || null;
            if (!answerKeyObj) throw new Error('Select an answer key before scanning');
            let detectionResponse;
            try {
              const trackingFrame = this.nextTrackingFrame();
              detectionResponse = await this.scanService.detectFrame({
                imageBuffer: base64Image,
                answerKeyId: answerKeyObj.id,
                trackingSessionId: trackingFrame.trackingSessionId,
                frameId: trackingFrame.frameId,
                previewOnly: true
              }).toPromise();
              if (!this.isCurrentAutoDetection(detectionGeneration)) return;
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
              this.clearLiveAnswerOverlay();
              this.liveDetectionStatus = 'reject';
              this.liveQualityMessage = msg;
              return;
            }

            const detectedAnswers = detectionResponse.detectedAnswers || [];
            const confidenceScores = detectionResponse.confidenceScores || [];
            const avgConfidence = detectionResponse.averageConfidence || 0;
            const allDetected = detectedAnswers.every((a: string) => a !== '');
            const recommendation = (detectionResponse as any).qualityGate?.recommendation;

            const filledCount = detectedAnswers.filter((a: string) => a && String(a).trim() !== '').length;
            const markedRows = Array.isArray((detectionResponse as any).markedLetters)
              ? (detectionResponse as any).markedLetters
              : [];
            const completeRowMap = detectedAnswers.length === 50 && markedRows.length === 50;
            const detectionDetails = (detectionResponse as any).details || {};
            this.updateLiveAnswerOverlay(detectionResponse, captureBlob);
            const ambiguousRows = markedRows
              .filter((row: string[]) => Array.isArray(row) && row.length > 1).length;
            const source = detectionDetails.source;
            const trustedGeometry = detectionDetails.currentSheetGeometry === true
              && !['adaptive-ring-diagnostic', 'adaptive-multiple-marks'].includes(source);
            const detectionSignature = markedRows
              .map((row: string[]) => Array.isArray(row) && row.length ? row.join('') : '-')
              .join('');
            const sheetFingerprint = String(detectionDetails.sheetFingerprint || '');
            const sheetFingerprintVersion = Number(detectionDetails.sheetFingerprintVersion || 0);
            const duplicateSheet = (detectionResponse as any).duplicateSheet === true
              || detectionDetails.duplicateSheet === true;
            const removalRequired = (detectionResponse as any).removalRequired === true
              || detectionDetails.removalRequired === true;
            const backendSheetChanged = (detectionResponse as any).sheetIdentityChanged === true
              || detectionDetails.sheetIdentityChanged === true;
            const backendNewSheetFrames = Number(
              (detectionResponse as any).newSheetFrames
              ?? detectionDetails.newSheetFrames
              ?? 0
            );
            const backendRequiredNewSheetFrames = Number(
              (detectionResponse as any).requiredNewSheetFrames
              ?? detectionDetails.requiredNewSheetFrames
              ?? this.REQUIRED_REPLACEMENT_SHEET_FRAMES
            );

            const placement = (detectionResponse as any).placement
              || detectionDetails.placement;
            const rejectionReason = String(
              (detectionResponse as any).qualityGate?.reason
              || (detectionResponse as any).details?.rejectionReason
              || ''
            );
            const sheetPresence = (detectionResponse as any).sheetPresence
              ?? (detectionResponse as any).details?.sheetPresence;
            this.updateLiveDetailRequirement(sheetPresence, recommendation !== 'accept');
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
            // hashes move under rotation. Prefer two explicit no-page frames;
            // if pages are swapped between polls, require two consistent,
            // strongly different fingerprints before lifting the barrier.
            if (this.awaitingSheetRemoval) {
              const sheetBoundaryConfirmed = this.observeSheetChangeBarrier({
                confirmedNoSheet,
                recommendation,
                completeRowMap,
                trustedGeometry,
                detectionSignature,
                sheetFingerprint,
                sheetFingerprintVersion,
                duplicateSheet,
                removalRequired,
                backendSheetChanged,
                backendNewSheetFrames,
                backendRequiredNewSheetFrames
              });
              if (!sheetBoundaryConfirmed) return;
            }

            const detectedClassroomId = Number((detectionResponse as any).classroomId || 0);
            if (
              detectedClassroomId > 0
              && detectedClassroomId !== this.selectedClassroomId
            ) {
              this.selectedClassroomId = detectedClassroomId;
              await this.onClassroomChange();
              if (!this.isCurrentAutoDetection(detectionGeneration)) return;
            }
            const detectedSeq = String(
              (detectionResponse as any).sequence
              || (detectionResponse as any).rawOcrText
              || ''
            ).trim();
            if (detectedSeq) {
              await this.autoPickAnswerKeyAndStudent(detectedSeq);
              if (!this.isCurrentAutoDetection(detectionGeneration)) return;
            }

            this.liveDetection = detectionResponse;
            if (this.studentSequenceReviewRequired) {
              this.liveDetectionStatus = 'scanning';
              this.liveQualityMessage = 'Select the student above, or use Scan & Grade to retry the sequence';
              return;
            }
            this.recordLiveFrame(
              avgConfidence,
              filledCount,
              detectedAnswers.length,
              detectedAnswers as string[],
              completeRowMap,
              recommendation === 'accept'
            );
            this.liveDebugMessage = '';

            if (detectionSignature && detectionSignature === this.stableDetectionSignature) {
              this.stableDetectionFrames++;
            } else {
              this.stableDetectionSignature = detectionSignature;
              this.stableDetectionFrames = 1;
            }

            const liveDetectionToken = String((detectionResponse as any).detectionToken || '');
            // The backend only creates a token when the current image has a
            // trusted 50-row geometry and no unresolved answer rows. Blank
            // and multi-mark rows are deliberate, scoreable outcomes (zero
            // points), not a reason to delay a newly presented sheet for
            // three near-identical camera frames. Finalizing this exact token
            // also avoids rereading a different 4K frame after acceptance.
            const verifiedScorableSheetRead = recommendation === 'accept'
              && trustedGeometry
              && completeRowMap
              && !!liveDetectionToken;
            const detectionIsReady = verifiedScorableSheetRead || (
              recommendation === 'accept'
              && detectedAnswers.length === 50
              && (ambiguousRows > 0
                ? avgConfidence >= 60
                : avgConfidence >= this.FRAME_CONFIDENCE_ACCEPT)
            );
            // Keep multi-frame confirmation only for a frame that has not
            // passed the backend's authoritative, token-backed quality gate.
            const stableFramesRequired = verifiedScorableSheetRead
              ? 1
              : this.REQUIRED_STABLE_FRAMES;
            const acceptedAt = Date.now();
            const shouldAutoCapture = detectionIsReady
              && this.stableDetectionFrames >= stableFramesRequired
              && acceptedAt >= this.autoScanCooldownUntil;

            if (shouldAutoCapture) {
              const fingerprintDistance = this.fingerprintDistance(
                sheetFingerprint,
                this.lastCapturedFingerprint
              );
              const samePhysicalSheet = detectionSignature === this.lastCapturedSignature
                && (
                  !sheetFingerprint
                  || !this.lastCapturedFingerprint
                  || fingerprintDistance <= this.SAME_SHEET_FINGERPRINT_DISTANCE
                );
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
              this.lastProcessedTime = acceptedAt;
              this.pendingCapturedSignature = detectionSignature;
              this.pendingCapturedFingerprint = sheetFingerprint;
              this.pendingCapturedStudentId = this.selectedStudentId;
              this.pendingCapturedSequence = detectedSeq;
              this.stopAutoDetection();
              this.stopStreamPoll();

              this.liveDetectionStatus = 'processing';
              this.autoCapturedScan = true;
              this.capturedImage = liveFrame;
              // Preserve the verified static-form tracking state while this
              // result is saved. The next physical sheet normally occupies
              // the same camera region and can use the fast optical-flow
              // route; a moved/replaced page still has to pass full current-
              // frame geometry and quality validation or falls back to SIFT.
              if (liveDetectionToken) {
                // Persist the exact frame and result already verified by the
                // backend. The full-resolution capture remains available as
                // a fallback if the short-lived token expires.
                setTimeout(() => this.finalizeAcceptedDetection(liveDetectionToken), 0);
              } else {
                setTimeout(() => this.processCapturedImage(), 50);
              }
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
            if (!this.isCurrentAutoDetection(detectionGeneration)) return;
            console.error('OMR detection error:', error);
            const reason = this.detectionRequestErrorMessage(error);
            this.liveDebugMessage = '';
            this.clearLiveAnswerOverlay();
            this.liveDetectionStatus = 'reject';
            this.liveQualityMessage = reason;
        } finally {
            URL.revokeObjectURL(sourceFrameUrl);
            if (detectionGeneration === this.autoDetectionGeneration) {
              this.autoDetectionInFlight = false;
            }
        }
        })();
    } catch (error: any) {
      if (!this.isCurrentAutoDetection(detectionGeneration)) return;
      console.error('Auto-detection error:', error);
      const reason = this.cameraRequestErrorMessage(error);
      this.noteCameraFrameFailure(reason, error);
      this.liveDebugMessage = '';
      this.clearLiveAnswerOverlay();
      this.liveDetectionStatus = 'reject';
      this.liveQualityMessage = reason;
      this.autoDetectionInFlight = false;
    } finally {
      this.liveDetectionBusy = false;
      if (detectionGeneration === this.autoDetectionGeneration) {
        this.autoDetectionInFlight = false;
      }
      this.queueFreshFrameDetection();
    }
  }

  private isCurrentAutoDetection(generation: number) {
    return generation === this.autoDetectionGeneration
      && (this.scannerSessionMode == null || this.scannerSessionMode === this.isOfflineMode)
      && this.detectionActive
      && this.isScannerActive
      && this.autoScanEnabled
      && this.cameraViewActive !== false
      && !document.hidden
      && !this.destroyed;
  }

  private async performOfflineLiveDetection(blob: Blob, generation: number): Promise<void> {
    if (!this.isOfflineMode) return;
    this.nativeDetectionBusy = true;
    try {
      const answerKeyId = this.selectedAnswerKeyId;
      const classroomId = this.selectedClassroomId;
      const key = this.answerKeys.find(item => item.id === this.selectedAnswerKeyId);
      const questionCount = Number(key?.numQuestions || 0);
      if (!questionCount) throw new Error('Select an answer key before scanning');
      const frame = new File([blob], 'offline-live-frame.jpg', {
        type: blob.type || 'image/jpeg',
        lastModified: Date.now(),
      });
      let result = await this.detectOfflineFrame(frame, questionCount, this.nextTrackingFrame());
      if (!this.isCurrentAutoDetection(generation)) return;
      if (answerKeyId !== this.selectedAnswerKeyId || classroomId !== this.selectedClassroomId) return;
      // Some packaged workers return the 50-row result but omit their optional
      // footer metadata. Read the footer directly only on those frames, then
      // apply the existing two-frame identity confirmation before auto-match.
      const sequenceReader = this.offlineOmrService as any;
      if (!result.sequence && !result.sequenceCandidate
        && typeof sequenceReader?.detectSequenceFromImage === 'function') {
        try {
          const footer = await sequenceReader.detectSequenceFromImage(frame, result.overlayGeometry);
          if (footer?.sequence || footer?.sequenceCandidate) {
            result = {
              ...result,
              // Independent fallback reads are always confirmed across two
              // frames, even when the classifier emits a high-confidence digit.
              sequence: undefined,
              sequenceCandidate: footer.sequence || footer.sequenceCandidate,
              sequenceConfidence: footer.confidence,
              sequenceRawDigits: footer.rawDigits,
              sequenceBoxCount: footer.boxCount,
              sequenceDigitConfidences: footer.digitConfidences,
            };
          }
        } catch (error) {
          console.warn('Independent footer sequence read failed:', error);
        }
      }
      // Retry unresolved detail at camera resolution instead of repeatedly
      // feeding undersized bubbles to the classifier.
      // Keep the successful detail level for this sheet, including the second
      // confirmation frame. Dropping back immediately can alternate clear and
      // undersampled reads indefinitely.
      this.updateLiveDetailRequirement(result.sheetPresence, !result.gradeable);
      const detectedSequence = this.resolveOfflineSequence(result);
      if (!detectedSequence && this.autoSelectedStudentId && this.selectedStudentId === this.autoSelectedStudentId) {
        const sameRecentSheet = !!result.sheetFingerprint && !!this.offlineAutoStudentFingerprint
          && Date.now() - this.offlineAutoStudentAt < 15000
          && this.fingerprintDistance(result.sheetFingerprint, this.offlineAutoStudentFingerprint) <= this.SAME_SHEET_FINGERPRINT_DISTANCE;
        if (!sameRecentSheet) {
          this.selectedStudentId = null;
          this.autoSelectedStudentId = null;
        }
      }
      await this.autoPickAnswerKeyAndStudent(detectedSequence);
      if (!this.isCurrentAutoDetection(generation)) return;
      if (answerKeyId !== this.selectedAnswerKeyId || classroomId !== this.selectedClassroomId) return;
      if (detectedSequence && this.autoSelectedStudentId && this.selectedStudentId === this.autoSelectedStudentId) {
        this.offlineAutoStudentFingerprint = result.sheetFingerprint || '';
        this.offlineAutoStudentAt = Date.now();
      }

      const markedLetters = result.markedLetters
        || result.answers.map(answer => answer ? [answer] : []);
      const completeRowMap = result.rowMapComplete === true
        && result.answers.length === questionCount
        && markedLetters.length === questionCount;
      const rowStates = result.rowStates || [];
      const criticalFailures = Array.isArray(result.qualityMetrics?.['criticalFailures'])
        ? result.qualityMetrics['criticalFailures'] as unknown[]
        : [];
      // Use the same explicit marks rendered by the overlay. A native row can
      // be labelled correctly while its conservative state remains uncertain;
      // two fresh frames with the same complete map safely resolve that case.
      const consensusAnswers = Array.from({ length: questionCount }, (_, index) => {
        const marks = markedLetters[index] || [];
        return marks.length === 1 ? marks[0] : String(result.answers[index] || '');
      });
      const consensusRowMapComplete = result.temporalEligible === true
        && result.geometryVerified === true
        && result.answers.length === questionCount
        && markedLetters.length === questionCount
        && criticalFailures.length === 0
        && Array.from({ length: questionCount }).every((_, index) => {
          const state = rowStates[index] || 'uncertain';
          const marks = markedLetters[index] || [];
          if (marks.length === 1 && /^[A-D]$/.test(consensusAnswers[index])) return true;
          return state === 'single' ? marks.length === 1 && consensusAnswers[index] === marks[0]
            : state === 'blank' ? marks.length === 0 && consensusAnswers[index] === ''
            : state === 'multiple' ? marks.length >= 2 && consensusAnswers[index] === ''
            : false;
        });
      const normalizedSequence = detectedSequence || 'none';
      const candidateCanStabilize = (result.gradeable && completeRowMap) || consensusRowMapComplete;
      const stableStudentIdentity = this.selectedStudentId
        ? `student:${this.selectedStudentId}`
        : `sequence:${normalizedSequence}`;
      const signature = candidateCanStabilize
        ? `${markedLetters.map(row => row.length ? [...row].sort().join('') : '-').join(',')}|${stableStudentIdentity}`
        : '';
      const confirmationUpdate = this.updateOfflineConfirmation(
        signature,
        result,
        markedLetters,
        stableStudentIdentity
      );
      const stableFramesRequired = this.REQUIRED_STABLE_FRAMES;
      const temporalConsensusAccepted = !result.gradeable
        && consensusRowMapComplete
        && this.stableDetectionFrames >= stableFramesRequired;
      const effectiveResult: OfflineOmrResult = temporalConsensusAccepted
        ? {
            ...result,
            answers: consensusAnswers,
            markedLetters,
            rowStates: Array.from({ length: questionCount }, (_, index) =>
              markedLetters[index]?.length === 1
                ? 'single'
                : markedLetters[index]?.length > 1
                  ? 'multiple'
                  : 'blank'
            ),
            confidences: result.confidences,
            detectedCount: consensusAnswers.filter(Boolean).length,
            uncertainCount: 0,
            gradeable: true,
            rowMapComplete: true,
            overallConfidence: result.overallConfidence,
            reason: '',
          }
        : result;
      const effectiveMarkedLetters = effectiveResult.markedLetters || markedLetters;
      const effectiveCompleteRowMap = effectiveResult.rowMapComplete === true
        && effectiveResult.answers.length === questionCount
        && effectiveMarkedLetters.length === questionCount;
      const sheetFingerprint = String(result.sheetFingerprint || '');
      const sheetFingerprintVersion = Number(result.sheetFingerprintVersion || 0);
      // Keep the completed scan visible until removal/replacement is proven.
      // Fresh frames still feed the sheet barrier, but must not overwrite a
      // saved result with a transient low-quality reading of the same paper.
      if (this.awaitingSheetRemoval) {
        const sheetBoundaryConfirmed = this.observeSheetChangeBarrier({
          confirmedNoSheet: result.sheetPresence === 'absent',
          recommendation: effectiveResult.gradeable ? 'accept' : 'reject',
          completeRowMap: effectiveCompleteRowMap,
          trustedGeometry: result.geometryVerified === true,
          detectionSignature: signature,
          sheetFingerprint,
          sheetFingerprintVersion,
          duplicateSheet: false,
          removalRequired: false,
          backendSheetChanged: false,
          backendNewSheetFrames: 0,
          backendRequiredNewSheetFrames: this.REQUIRED_REPLACEMENT_SHEET_FRAMES,
          detectedSequence,
        });
        if (!sheetBoundaryConfirmed) return;
      }

      const holdingVerifiedSheet = !effectiveResult.gradeable
        && confirmationUpdate === 'held'
        && this.stableDetectionFrames > 0;
      if (holdingVerifiedSheet) {
        this.liveDetectionStatus = 'scanning';
        this.liveQualityMessage = this.offlineSequenceCandidateFrames > 0 && !this.selectedStudentId
          ? `Sheet ready — confirming student sequence ${this.offlineSequenceCandidateFrames}/${this.REQUIRED_SEQUENCE_CANDIDATE_FRAMES}`
          : `Rechecking alignment — holding stable scan ${this.stableDetectionFrames}/${stableFramesRequired}`;
        return;
      }

      this.liveResolvedRows = effectiveResult.geometryVerified === true
        ? (effectiveResult.rowStates || []).slice(0, questionCount)
          .filter(state => state === 'single' || state === 'blank' || state === 'multiple').length
        : 0;
      const liveResponse = {
        success: true,
        detectedAnswers: effectiveResult.answers,
        confidenceScores: effectiveResult.confidences,
        markedLetters: effectiveMarkedLetters,
        averageConfidence: effectiveResult.overallConfidence,
        sequence: detectedSequence,
        sequenceConfidence: result.sequenceConfidence || 0,
        offline: true,
        details: {
          source: result.source,
          currentSheetGeometry: result.geometryVerified === true,
          sheetPresence: result.sheetPresence,
          presenceConfidence: result.presenceConfidence,
          sheetFingerprint,
          sheetFingerprintVersion,
          overlayGeometry: result.overlayGeometry,
          qualityMetrics: result.qualityMetrics,
        },
        qualityGate: {
          recommendation: effectiveResult.gradeable ? 'accept' : 'reject',
          reason: effectiveResult.reason || (effectiveResult.gradeable ? 'Ready' : 'Waiting for a verified answer-sheet read'),
        },
      };
      this.liveDetection = liveResponse;
      if (result.overlayGeometry) {
        this.updateLiveAnswerOverlay(liveResponse, blob);
      } else {
        this.clearLiveAnswerOverlay();
      }
      this.recordLiveFrame(
        effectiveResult.overallConfidence,
        effectiveResult.detectedCount,
        questionCount,
        effectiveResult.answers,
        effectiveCompleteRowMap,
        effectiveResult.gradeable
      );


      if (!effectiveResult.gradeable) {
        const holdingRecentConfirmation = confirmationUpdate === 'held'
          && this.stableDetectionFrames > 0;
        this.liveDetectionStatus = consensusRowMapComplete || holdingRecentConfirmation
          ? 'scanning'
          : 'reject';
        this.liveQualityMessage = holdingRecentConfirmation
          ? `Frame briefly unclear — holding stable scan ${this.stableDetectionFrames}/${stableFramesRequired}`
          : consensusRowMapComplete
          ? `Confirming the same answers and student ${this.stableDetectionFrames}/${stableFramesRequired}`
          : effectiveResult.reason
            || `Keep the full sheet still — resolved ${Math.max(0, questionCount - effectiveResult.uncertainCount)}/${questionCount} rows locally`;
        return;
      }

      const zeroPointRows = effectiveMarkedLetters.filter(row => row.length !== 1).length;
      // Require exact row agreement across two independently captured frames.
      // A single sharp-looking frame can still contain glare or a transient
      // registration offset which confidently selects the wrong bubble.
      const ready = this.stableDetectionFrames >= stableFramesRequired;
      this.liveDetectionStatus = ready ? 'accept' : 'scanning';
      this.liveQualityMessage = ready
        ? (!this.selectedClassroomId || !this.selectedStudentId
          ? detectedSequence
            ? `Sequence ${detectedSequence} detected, but no unique student match was found. Check the selected classroom and answer key.`
            : this.offlineSequenceCandidateFrames > 0
              ? `Sheet ready — confirming student sequence ${this.offlineSequenceCandidateFrames}/${this.REQUIRED_SEQUENCE_CANDIDATE_FRAMES}`
              : 'Sheet ready — student sequence not read; keep the bottom number boxes fully visible and in focus'
          : zeroPointRows > 0
            ? `Sheet ready — ${zeroPointRows} blank or multi-mark row${zeroPointRows === 1 ? '' : 's'} will score zero`
            : 'Sheet ready — capturing locally')
        : `Confirming stable scan ${this.stableDetectionFrames}/${stableFramesRequired}`;

      if (
        ready
        && this.selectedClassroomId
        && this.selectedStudentId
        && Date.now() >= this.autoScanCooldownUntil
      ) {
        this.lastProcessedTime = Date.now();
        this.pendingCapturedSignature = signature;
        this.pendingCapturedFingerprint = sheetFingerprint;
        this.pendingCapturedStudentId = this.selectedStudentId;
        this.pendingCapturedSequence = detectedSequence || '';
        this.isProcessing = true;
        this.autoCapturedScan = true;
        if (this.autoRecordEnabled) {
          // The accepted native result already describes this exact preview
          // frame. Save it directly without stopping the Pi stream, hashing a
          // multi-megabyte JPEG, switching tabs, or running OMR a second time.
          this.applyOfflineDetectionResult(effectiveResult, questionCount);
          this.offlineFingerprint = sheetFingerprint;
          const saved = await this.saveOfflineManualGrade(frame, true);
          if (!this.isOfflineMode) return;
          if (!saved) {
            this.autoCapturedScan = false;
            this.pendingCapturedSignature = '';
            this.pendingCapturedFingerprint = '';
            this.pendingCapturedStudentId = null;
            this.pendingCapturedSequence = '';
            this.stableDetectionSignature = '';
            this.stableDetectionFrames = 0;
            this.liveDetectionStatus = 'reject';
            this.liveQualityMessage = 'Automatic local save failed. Review the message, then present the sheet again.';
          }
        } else {
          await this.useOfflineCameraFrame(blob, effectiveResult, true);
        }
      }
    } catch (error: any) {
      if (!this.isCurrentAutoDetection(generation)) return;
      if (this.awaitingSheetRemoval) {
        if (error?.sheetPresence === 'absent') {
          this.observeSheetChangeBarrier({
            confirmedNoSheet: true,
            recommendation: 'reject',
            completeRowMap: false,
            trustedGeometry: false,
            detectionSignature: '',
            sheetFingerprint: '',
            sheetFingerprintVersion: 0,
            duplicateSheet: false,
            removalRequired: false,
            backendSheetChanged: false,
            backendNewSheetFrames: 0,
            backendRequiredNewSheetFrames: this.REQUIRED_REPLACEMENT_SHEET_FRAMES,
            detectedSequence: null,
          });
          return;
        }
        this.liveQualityMessage = 'Scan complete. Waiting for the next sheet.';
        return;
      }
      // A single native read can fail while the Pi is delivering the next
      // frame (or while Android is under short-lived memory pressure). Keep a
      // recent, verified first vote so the next matching frame can complete
      // confirmation. Expired evidence is still discarded below.
      if (
        this.stableDetectionFrames >= this.REQUIRED_STABLE_FRAMES
        && error?.sheetPresence !== 'absent'
        && Date.now() - this.offlineConfirmationAt
          <= (this.OFFLINE_CONFIRMATION_MAX_AGE_MS || 20000)
      ) {
        this.liveDetectionStatus = 'scanning';
        this.liveQualityMessage = 'Rechecking alignment — holding the previous read briefly';
        return;
      }
      if (
        this.stableDetectionFrames > 0
        && error?.sheetPresence !== 'absent'
        && Date.now() - this.offlineConfirmationAt
          <= (this.OFFLINE_CONFIRMATION_MAX_AGE_MS || 20000)
      ) {
        this.liveDetectionStatus = 'scanning';
        this.liveQualityMessage = `Temporary read missed — holding stable scan ${this.stableDetectionFrames}/${this.REQUIRED_STABLE_FRAMES || 2}`;
        return;
      }
      this.stableDetectionSignature = '';
      this.stableDetectionFrames = 0;
      this.clearLiveAnswerOverlay();
      this.liveDetectionStatus = 'reject';
      this.liveResolvedRows = 0;
      this.liveQualityMessage = error?.message || 'No complete answer sheet detected yet';
    } finally {
      this.nativeDetectionBusy = false;
      if (generation === this.autoDetectionGeneration) {
        this.autoDetectionInFlight = false;
      }
    }
  }

  private updateOfflineConfirmation(
    signature: string,
    result: OfflineOmrResult,
    marks: string[][],
    studentIdentity: string,
    now = Date.now()
  ): 'advanced' | 'held' | 'reset' {
    const recent = now - this.offlineConfirmationAt
      <= (this.OFFLINE_CONFIRMATION_MAX_AGE_MS || 20000);
    const previousFingerprint = String(this.offlineConfirmationFingerprint || '');
    const currentFingerprint = String(result.sheetFingerprint || '');
    const sameSheet = result.sheetFingerprintVersion === 2
      && previousFingerprint.length > 0
      && (previousFingerprint === currentFingerprint
        || this.fingerprintDistance(previousFingerprint, currentFingerprint) <= 7);
    const identityPromoted = this.offlineConfirmationIdentity === 'sequence:none'
      && studentIdentity.startsWith('student:');
    const previousAnswerSignature = String(this.stableDetectionSignature || '').split('|')[0];
    const currentAnswerSignature = String(signature || '').split('|')[0];
    const promotionMatchesAnswers = identityPromoted
      && !!previousAnswerSignature
      && previousAnswerSignature === currentAnswerSignature;
    const safeIdentityPromotion = identityPromoted
      && (sameSheet || promotionMatchesAnswers);
    const fingerprintChanged = !!previousFingerprint && !!currentFingerprint && !sameSheet;
    if (
      !recent || result.sheetPresence === 'absent' || fingerprintChanged
      || (this.offlineConfirmationIdentity !== studentIdentity && !safeIdentityPromotion)
    ) {
      this.stableDetectionSignature = '';
      this.stableDetectionFrames = 0;
    }
    if (result.sheetPresence === 'absent') return 'reset';
    if (signature) {
      // Sequence recognition can finish one frame after OMR. Resolving an
      // unknown identity to a student on the same fingerprint must strengthen
      // the existing vote, not make identical answers start over at 1/2.
      const promotedMatchingVote = identityPromoted
        && recent
        && safeIdentityPromotion
        && this.stableDetectionFrames > 0
        && previousAnswerSignature === currentAnswerSignature;
      this.stableDetectionFrames = signature === this.stableDetectionSignature
        || promotedMatchingVote
        ? this.stableDetectionFrames + 1
        : 1;
      this.stableDetectionSignature = signature;
      this.offlineConfirmationAt = now;
      this.offlineConfirmationIdentity = studentIdentity;
      this.offlineConfirmationFingerprint = currentFingerprint;
      return 'advanced';
    }
    const previousRows = String(this.stableDetectionSignature || '').split('|')[0].split(',');
    const failures = result.qualityMetrics?.['criticalFailures'];
    const identityMatches = this.offlineConfirmationIdentity === studentIdentity;
    const rowsCompatible = marks.length === previousRows.length
      && marks.every((row, index) => {
        const state = result.rowStates?.[index];
        if (state === 'uncertain' && row.length === 0) return true;
        return (row.length ? [...row].sort().join('') : '-') === previousRows[index];
      });
    // A registration miss contributes no answer or identity vote. Keep the
    // last good vote briefly so a fresh matching read can finish 1/2, without
    // extending its age or presenting stale geometry as ready to capture.
    const transientRegistrationMiss = result.geometryVerified === false
      && marks.every(row => row.length === 0)
      && (!Array.isArray(failures) || failures.every(failure =>
        ['registration', 'geometry', 'localization'].includes(String(failure))));
    const compatible = recent && this.stableDetectionFrames > 0
      && identityMatches && !fingerprintChanged
      && (transientRegistrationMiss || (
        result.geometryVerified === true
        && Array.isArray(failures) && failures.length === 0
        && rowsCompatible
      ));
    if (!compatible) {
      this.stableDetectionSignature = '';
      this.stableDetectionFrames = 0;
      return 'reset';
    }
    return 'held';
  }

  private observeSheetChangeBarrier(state: {
    confirmedNoSheet: boolean;
    recommendation: string | undefined;
    completeRowMap: boolean;
    trustedGeometry: boolean;
    detectionSignature: string;
    sheetFingerprint: string;
    sheetFingerprintVersion: number;
    duplicateSheet: boolean;
    removalRequired: boolean;
    backendSheetChanged: boolean;
    backendNewSheetFrames: number;
    backendRequiredNewSheetFrames: number;
    detectedSequence?: string | null;
  }): boolean {
    if (!this.awaitingSheetRemoval) return true;

    if (state.confirmedNoSheet) {
      this.noSheetFrames++;
      this.replacementSheetFingerprint = '';
      this.replacementSheetFrames = 0;
      this.liveDetectionStatus = 'scanning';
      if (this.noSheetFrames >= this.REQUIRED_NO_SHEET_FRAMES) {
        this.releaseSheetChangeBarrier('Previous sheet removed. Ready for the next sheet');
        // This is still the empty frame that proved removal. Let the next
        // frame establish and grade the new page.
        return false;
      }
      this.liveQualityMessage = `Confirming sheet removal ${this.noSheetFrames}/${this.REQUIRED_NO_SHEET_FRAMES}`;
      return false;
    }

    this.noSheetFrames = 0;
    const identityDistance = state.sheetFingerprintVersion === 2
      ? this.fingerprintDistance(
          state.sheetFingerprint.slice(0, 6),
          this.lastCapturedFingerprint.slice(0, 6)
        )
      : Number.MAX_SAFE_INTEGER;
    const studentIdentityChanged = !!this.lastCapturedStudentId
      && !!this.selectedStudentId
      && this.lastCapturedStudentId !== this.selectedStudentId;
    const currentAnswerSignature = String(state.detectionSignature || '').split('|')[0];
    const lastAnswerSignature = String(this.lastCapturedSignature || '').split('|')[0];
    const stableContentChanged = !!currentAnswerSignature
      && !!lastAnswerSignature
      && currentAnswerSignature !== lastAnswerSignature;
    const sequenceChanged = !!state.detectedSequence
      && !!this.lastCapturedSequence
      && String(Number(state.detectedSequence)) !== String(Number(this.lastCapturedSequence));
    const fingerprintIdentityChanged = !!state.sheetFingerprint
      && !!this.lastCapturedFingerprint
      && state.sheetFingerprintVersion === 2
      && identityDistance >= this.NEW_SHEET_IDENTITY_DISTANCE;
    // Answer-map, student and confirmed-sequence changes are independent of
    // native fingerprint support. This is essential on the Windows/browser
    // fallback, where the old implementation could never prove replacement.
    const replacementEvidence = sequenceChanged
      || studentIdentityChanged
      || stableContentChanged
      || fingerprintIdentityChanged;
    const hardDuplicateHold = (state.duplicateSheet || state.removalRequired)
      && !state.backendSheetChanged
      && !sequenceChanged;
    const currentFrameProvesReplacement = !hardDuplicateHold
      && state.recommendation === 'accept'
      && state.completeRowMap
      && state.trustedGeometry
      && (state.backendSheetChanged || replacementEvidence);

    if (currentFrameProvesReplacement) {
      const candidateIdentity = state.sheetFingerprint
        ? `fingerprint:${state.sheetFingerprint}`
        : `signature:${state.detectionSignature}`;
      const previousFingerprint = this.replacementSheetFingerprint.startsWith('fingerprint:')
        ? this.replacementSheetFingerprint.slice('fingerprint:'.length)
        : '';
      const sameCandidate = candidateIdentity === this.replacementSheetFingerprint
        || (
          !!previousFingerprint
          && !!state.sheetFingerprint
          && this.fingerprintDistance(previousFingerprint, state.sheetFingerprint)
            <= this.SAME_SHEET_FINGERPRINT_DISTANCE
        );
      if (sameCandidate) {
        this.replacementSheetFrames++;
      } else {
        this.replacementSheetFingerprint = candidateIdentity;
        this.replacementSheetFrames = 1;
      }

      // sheetIdentityChanged is emitted only after the server has already
      // observed two stable, sufficiently distant fingerprints. Older
      // backends expose only the raw fingerprint, so confirm that locally.
      const requiredReplacementFrames = state.backendSheetChanged
        ? 1
        : this.REQUIRED_REPLACEMENT_SHEET_FRAMES;
      this.liveDetectionStatus = 'scanning';
      this.liveQualityMessage = `Confirming new sheet ${this.replacementSheetFrames}/${requiredReplacementFrames}`;
      if (this.replacementSheetFrames >= requiredReplacementFrames) {
        this.releaseSheetChangeBarrier('New sheet confirmed. Capturing when stable', true);
        // Unlike an empty removal frame, this frame is a verified new page
        // and can continue through the normal stability/quality gate.
        return true;
      }
      return false;
    }

    this.replacementSheetFingerprint = '';
    this.replacementSheetFrames = 0;
    this.liveDetectionStatus = 'scanning';
    this.liveQualityMessage = hardDuplicateHold && state.backendNewSheetFrames > 0
      ? `Confirming new sheet ${state.backendNewSheetFrames}/${Math.max(
          state.backendNewSheetFrames,
          state.backendRequiredNewSheetFrames
        )}`
      : hardDuplicateHold
        ? 'Previous sheet is still present. Remove it before scanning again'
        : 'Remove the previous sheet completely, or present a clearly different sheet';
    return false;
  }

  private releaseSheetChangeBarrier(message: string, preserveCurrentStudent = false) {
    this.awaitingSheetRemoval = false;
    this.noSheetFrames = 0;
    this.replacementSheetFingerprint = '';
    this.replacementSheetFrames = 0;
    this.resetTrackingSession();
    this.lastCapturedSignature = '';
    this.lastCapturedFingerprint = '';
    this.lastCapturedStudentId = null;
    this.lastCapturedSequence = '';
    this.clearOfflineSequenceCandidate();
    if (!preserveCurrentStudent) {
      if (this.autoSelectedStudentId && this.selectedStudentId === this.autoSelectedStudentId) this.selectedStudentId = null;
      this.autoSelectedStudentId = null;
    }
    this.stableDetectionSignature = '';
    this.stableDetectionFrames = 0;
    this.liveDetectionStatus = 'scanning';
    this.liveQualityMessage = message;
  }

  onFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    // Allow the same image to be selected again after it has been cleared.
    input.value = '';
    if (file) this.prepareSelectedImage(file);
  }

  async startDeviceCamera() {
    this.deviceCameraError = '';

    if (!navigator.mediaDevices?.getUserMedia) {
      this.cameraInput?.nativeElement.click();
      return;
    }

    this.stopDeviceCamera();
    this.isStartingDeviceCamera = true;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 2560 }
        },
        audio: false
      });

      this.deviceCameraStream = stream;
      const videoTrack = stream.getVideoTracks()[0];
      const capabilities = (videoTrack as any)?.getCapabilities?.() || {};
      if (Array.isArray(capabilities.focusMode) && capabilities.focusMode.includes('continuous')) {
        void videoTrack.applyConstraints({ advanced: [{ focusMode: 'continuous' } as any] }).catch(() => undefined);
      }
      this.isDeviceCameraActive = true;
      const video = this.deviceVideo.nativeElement;
      video.srcObject = stream;
      await video.play();
    } catch (error: any) {
      console.error('Unable to start device camera:', error);
      this.stopDeviceCamera();
      this.deviceCameraError = error?.name === 'NotAllowedError'
        ? 'Camera access was denied. Allow camera permission, then try again.'
        : 'The device camera could not be opened. You can use the camera app instead.';
    } finally {
      this.isStartingDeviceCamera = false;
    }
  }

  captureDevicePhoto() {
    const video = this.deviceVideo?.nativeElement;
    if (!video || !this.deviceCameraStream || video.videoWidth === 0 || video.videoHeight === 0) {
      this.showToastMessage('Camera is still starting. Try again in a moment.');
      return;
    }

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext('2d');
    if (!context) {
      this.showToastMessage('Could not capture the camera image');
      return;
    }

    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(blob => {
      if (!blob) {
        this.showToastMessage('Could not capture the camera image');
        return;
      }

      const file = new File([blob], `answer-sheet-${Date.now()}.jpg`, {
        type: 'image/jpeg',
        lastModified: Date.now()
      });
      this.stopDeviceCamera();
      this.prepareSelectedImage(file);
      this.showToastMessage('Photo captured. Review it before scanning.');
    }, 'image/jpeg', 0.92);
  }

  stopDeviceCamera() {
    this.deviceCameraStream?.getTracks().forEach(track => track.stop());
    this.deviceCameraStream = null;
    this.isDeviceCameraActive = false;

    const video = this.deviceVideo?.nativeElement;
    if (video) {
      video.pause();
      video.srcObject = null;
    }
  }

  openNativeCamera() {
    this.stopDeviceCamera();
    this.cameraInput?.nativeElement.click();
  }

  private prepareSelectedImage(file: File) {
    const validTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/bmp', 'image/tiff'];
    if (!validTypes.includes(file.type)) {
      this.showToastMessage('Please select a valid image file (JPEG, PNG, GIF, BMP, TIFF)');
      return;
    }

    if (file.size > 10 * 1024 * 1024) {
      this.showToastMessage('File size must be less than 10MB');
      return;
    }

    this.clearSelection();
    const selectionRun = this.imageSelectionRun;
    void prepareScanImage(file).then(processedFile => {
      if (selectionRun !== this.imageSelectionRun || this.destroyed) return;
      this.selectedFile = processedFile;
      this.previewUrl = URL.createObjectURL(processedFile);
      void this.detectOfflineAnswers();
    }).catch(error => {
      if (selectionRun !== this.imageSelectionRun || this.destroyed) return;
      console.error('Image preparation failed:', error);
      this.showToastMessage('Could not read this image. Try a PNG or JPEG photo.');
    });
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
      this.prepareSelectedImage(file);
    }
  }

  clearSelection() {
    this.imageSelectionRun++;
    this.stopDeviceCamera();
    if (this.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(this.previewUrl);
    this.selectedFile = null;
    this.previewUrl = null;
    this.offlineDetectionRun++;
    this.offlineDetectionStatus = 'idle';
    this.offlineDetectionMessage = '';
    this.resetOfflineDetectionResult();
  }

  private resetOfflineDetectionResult(): void {
    this.offlineAnswers = [];
    this.offlineConfidences = [];
    this.offlineReviewed = [];
    this.offlineGradeable = false;
    this.offlineFingerprint = '';
    this.offlineMarkedLetters = [];
    this.offlineProcessingMs = 0;
    this.offlineOverallConfidence = 0;
    this.offlineAnchorMethod = '';
    this.offlineQrData = '';
  }

  clearCameraMode() {
    // This method is bound to the visible "Stop Camera" button. Stop the
    // connection without erasing the selected exam/student or the accepted
    // sheet barrier; otherwise stop/start could grade the same page twice.
    this.cameraRequestedActive = false;
    this.stopExternalCameraSession();
    this.clearAutoScanCooldown();
    this.capturedImage = null;
    this.streamFrameBlobUrl = null;
    this.noSheetFrames = 0;
    this.pendingCapturedSignature = '';
    this.pendingCapturedFingerprint = '';
    this.pendingCapturedStudentId = null;
    this.pendingCapturedSequence = '';
    this.replacementSheetFingerprint = '';
    this.replacementSheetFrames = 0;
    this.autoCapturedScan = false;
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
        if (width >= height && width > maxDimension) {
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
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, width, height);
        ctx.filter = 'grayscale(100%)';
        ctx.drawImage(img, 0, 0, width, height);
        // q92 is the lowest tested setting that kept every labeled 1440px
        // sheet gradeable, including uniformly shaded C rows.
        const processedBase64 = canvas.toDataURL('image/jpeg', 0.92);
        resolve(processedBase64);
      };
      img.onerror = (err) => reject(err);
      img.src = base64Image;
    });
  }

  async uploadAndProcess() {
    if (this.isProcessing || this.synchronizeScannerMode() || this.isOfflineMode) return;
    if (!this.selectedFile) {
      this.showToastMessage('Please select an image file first');
      return;
    }
    if (!this.selectedAnswerKeyId) {
      this.showToastMessage('Select an answer key before scanning');
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
    if (this.synchronizeScannerMode() || this.isOfflineMode) return;
    if (!this.capturedImage) {
      this.isProcessing = false;
      return;
    }
    if (!this.selectedAnswerKeyId) {
      this.isProcessing = false;
      this.showToastMessage('Select an answer key before scanning');
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

  private async finalizeAcceptedDetection(detectionToken: string) {
    if (this.isOfflineMode) return;
    let fallingBack = false;
    try {
      const response = await this.scanService.finalizeDetection(
        detectionToken,
        this.selectedStudentId || undefined,
        this.selectedClassroomId || undefined
      ).toPromise();
      if (this.isOfflineMode) return;
      if (!response?.success || !response.scan) {
        throw new Error(response?.message || 'Fast finalization did not return a completed scan');
      }
      await this.handleSuccessfulScan(response, Number((response.scan as any).id));
    } catch (error: any) {
      if (this.isOfflineMode) return;
      if (error?.status === 422 && error?.error?.committed !== true
        && (error?.error?.code === 'STUDENT_SEQUENCE_REVIEW_REQUIRED'
          || /sequence|student/i.test(error.error?.message || error.message || ''))) {
        this.pauseForStudentSequenceReview(
          error.error?.message || 'Select the student, then scan this sheet again.'
        );
        return;
      }
      console.warn('Fast live finalization unavailable; using normal processing:', error);
      if (error?.error?.committed === true) {
        if (this.autoCapturedScan) this.rememberPendingCapturedSheet();
        this.beginAutoScanCooldown();
        this.showToastMessage(
          error.error?.message || 'The scan was saved. Reload scan history before scanning again.'
        );
        this.loadScanHistory();
        this.loadStats();
        return;
      }
      if (error?.error?.retrySafe === false) {
        if (this.autoCapturedScan) this.rememberPendingCapturedSheet();
        this.beginAutoScanCooldown();
        this.showToastMessage(error.error?.message || 'Select the student, then scan this sheet again.');
        return;
      }
      if (this.isAmbiguousScanOutcome(error)) {
        if (this.autoCapturedScan) this.rememberPendingCapturedSheet();
        this.beginAutoScanCooldown();
        this.showToastMessage(
          'The camera connection ended before saving could be confirmed. Check scan history before presenting another sheet.'
        );
        this.loadScanHistory();
        this.loadStats();
        return;
      }
      this.showToastMessage('Fast save unavailable; finishing through the normal scan path...');
      fallingBack = true;
      await this.processCapturedImage();
    } finally {
      if (!fallingBack) {
        this.isProcessing = false;
        this.resumeAutoScanAfterProcessing();
      }
    }
  }

  private resumeAutoScanAfterProcessing() {
    if (
      this.isProcessing
      || this.destroyed
      || !this.cameraViewActive
      || !this.cameraRequestedActive
      || this.scanMode !== 'camera'
      || !this.cameraBaseUrl
    ) return;
    this.capturedImage = null;
    const remaining = this.autoScanCooldownUntil - Date.now();
    this.isScannerActive = true;
    if (!this.trackingSessionId) this.beginTrackingSession();
    this.updateCameraUrls();
    if (!this.isPolling) this.startStreamPoll();
    if (this.autoScanEnabled && !this.detectionActive) this.startAutoDetection();
    if (remaining > 0) {
      this.liveDetectionStatus = 'processing';
      this.liveQualityMessage = `Result ready. Next auto-scan available in ${this.autoScanCooldownSeconds}s`;
    }
  }

  private isAmbiguousScanOutcome(error: any): boolean {
    const body = error?.error;
    if (
      body?.committed === true
      || body?.committed === false
      || body?.retrySafe === true
      || body?.retrySafe === false
      || body?.failure
    ) return false;
    const status = error?.status;
    const noDefinitiveHttpResponse = status === undefined || status === null || status === 0;
    const message = String(body?.message || body?.error || error?.message || '');
    return noDefinitiveHttpResponse || /timed?\s*out|timeout has occurred/i.test(message);
  }

  private beginAutoScanCooldown() {
    const shouldAwaitSheetChange = this.autoCapturedScan
      && this.scanMode === 'camera';
    this.autoCapturedScan = false;
    if (!shouldAwaitSheetChange) return;
    this.awaitingSheetRemoval = true;
    this.noSheetFrames = 0;
    this.replacementSheetFingerprint = '';
    this.replacementSheetFrames = 0;
    this.clearOfflineSequenceCandidate();
    if (this.autoSelectedStudentId && this.selectedStudentId === this.autoSelectedStudentId) {
      this.selectedStudentId = null;
    }
    this.autoSelectedStudentId = null;
    const cooldownMs = this.isOfflineMode
      ? this.OFFLINE_AUTO_SCAN_COOLDOWN_MS
      : this.AUTO_SCAN_COOLDOWN_MS;
    this.autoScanCooldownUntil = Date.now() + cooldownMs;
    this.autoScanCooldownSeconds = Math.ceil(cooldownMs / 1000);
    if (this.autoScanCooldownTimer) clearTimeout(this.autoScanCooldownTimer);
    this.autoScanCooldownTimer = setTimeout(() => {
      this.autoScanCooldownTimer = null;
      this.autoScanCooldownSeconds = 0;
      if (this.awaitingSheetRemoval && this.isScannerActive && !this.isProcessing) {
        this.liveDetectionStatus = 'scanning';
        this.liveQualityMessage = 'Result ready. Remove the previous sheet';
      }
    }, cooldownMs);
    this.liveDetectionStatus = 'processing';
    this.liveQualityMessage = 'Result ready. Waiting for the next sheet';
  }

  private clearAutoScanCooldown() {
    if (this.autoScanCooldownTimer) clearTimeout(this.autoScanCooldownTimer);
    this.autoScanCooldownTimer = null;
    this.autoScanCooldownUntil = 0;
    this.autoScanCooldownSeconds = 0;
  }

  private async handleSuccessfulScan(response: any, scanId: number) {
    if (this.isOfflineMode) return;
    const scanWithExam = response.scan as any;
    this.currentScan = { ...scanWithExam, scan_status: 'completed' };
    if (this.autoCapturedScan) {
      this.rememberPendingCapturedSheet();
    } else {
      this.pendingCapturedSignature = '';
      this.pendingCapturedFingerprint = '';
      this.pendingCapturedStudentId = null;
      this.pendingCapturedSequence = '';
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

    const elapsed = Number(response.processingTimings?.total || 0);
    console.log(`Scan completed successfully in ${elapsed.toFixed(0)} ms. Score:`, totalScore);
    this.showToastMessage(
      `Scan processed${elapsed > 0 ? ` in ${(elapsed / 1000).toFixed(1)}s` : ''}! Score: ${totalScore} correct`
      + `${blankCount > 0 ? `; ${blankCount} blank counted incorrect` : ''}`
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
  }

  async processScan(scanId: number) {
    if (this.isOfflineMode) return;
    console.log('Processing scan with ID:', scanId);
    try {
      const liveCapture = this.autoCapturedScan && this.scanMode === 'camera';
      const response = await this.scanService.processScan(scanId, liveCapture).toPromise();
      if (this.isOfflineMode) return;
      console.log('Process scan response:', response);

      if (response && response.success) {
        await this.handleSuccessfulScan(response, scanId);
      } else {
        const errorMsg = response?.message || 'Processing failed';
        console.error('Processing failed:', errorMsg);
        throw new Error(errorMsg);
      }
    } catch (error: any) {
      console.error('Processing error:', error);
      const serverMsg = error.error?.message || error.error?.error || error.message;
      if (error?.error?.committed === true) {
        if (this.autoCapturedScan) this.rememberPendingCapturedSheet();
        if (this.currentScan) {
          this.currentScan.scan_status = 'completed';
          this.currentScan.error_message = null;
        }
        this.beginAutoScanCooldown();
        this.showToastMessage(
          serverMsg || 'The scan was saved. Reload scan history before scanning another sheet.'
        );
        this.loadScanHistory();
        this.loadStats();
        return;
      }
      const failure = error.error?.failure;
      if (error?.error?.code === 'STUDENT_SEQUENCE_REVIEW_REQUIRED'
        || (error?.status === 422 && error?.error?.requiresReview && !failure)) {
        this.pauseForStudentSequenceReview(serverMsg || 'Select the student, then scan again.');
        return;
      }
      if (this.autoCapturedScan && !failure && this.isAmbiguousScanOutcome(error)) {
        this.rememberPendingCapturedSheet();
        if (this.currentScan) {
          this.currentScan.scan_status = 'processing';
          this.currentScan.error_message = 'Waiting for scan-history confirmation';
        }
        this.beginAutoScanCooldown();
        this.showToastMessage(
          'The connection ended before the save result was confirmed. Check scan history before scanning another sheet.'
        );
        this.loadScanHistory();
        this.loadStats();
        return;
      }
      this.pendingCapturedSignature = '';
      this.pendingCapturedFingerprint = '';
      this.pendingCapturedStudentId = null;
      this.pendingCapturedSequence = '';
      this.autoCapturedScan = false;
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
          subHeader: this.scanFailureSummary(failure.stage),
          cssClass: 'scanner-failure-alert',
          message: [
            failure.reason || serverMsg || 'The sheet could not be graded safely.',
            failure.recommendation || 'Reposition the sheet and scan again.'
          ].join('\n\n'),
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

  private rememberPendingCapturedSheet() {
    this.lastCapturedSignature = this.pendingCapturedSignature;
    this.lastCapturedFingerprint = this.pendingCapturedFingerprint;
    this.lastCapturedStudentId = this.pendingCapturedStudentId;
    this.lastCapturedSequence = this.pendingCapturedSequence;
    this.pendingCapturedSignature = '';
    this.pendingCapturedFingerprint = '';
    this.pendingCapturedStudentId = null;
    this.pendingCapturedSequence = '';
  }

  async detectSequenceFromCamera() {
    if (!this.cameraCaptureUrl) {
      this.showToastMessage('Camera URL missing — check URL field');
      return;
    }

    this.isProcessing = true;
    this.showToastMessage('Detecting sequence from camera...');

    try {
      const captureUrl = this.cameraCaptureRequestUrl();
      const blob = await this.http.get(captureUrl, {
        headers: this.cameraRequestHeaders(captureUrl),
        responseType: 'blob'
      }).toPromise();

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
    if (!this.cameraCaptureUrl) {
      this.showToastMessage('Camera URL missing — check URL field');
      return;
    }

    this.isProcessing = true;
    this.showToastMessage('Detecting exam sheet...');

    try {
      const captureUrl = this.cameraCaptureRequestUrl();
      const blob = await this.http.get(captureUrl, {
        headers: this.cameraRequestHeaders(captureUrl),
        responseType: 'blob'
      }).toPromise();

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
    if (!this.cameraCaptureUrl) {
      this.showToastMessage('Camera URL missing');
      return;
    }

    this.isCalibrating = true;
    this.calibrationImage = null;
    this.calibrationResults = null;
    this.showToastMessage('Capturing calibration image...');

    try {
      const captureUrl = this.cameraCaptureRequestUrl();
      const blob = await this.http.get(captureUrl, {
        headers: this.cameraRequestHeaders(captureUrl),
        responseType: 'blob'
      }).toPromise();

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

  /**
   * Require an explicit decision before the saved score can proceed to the
   * print dialog. Removing a result uses the backend's transactional delete,
   * which also removes its OMR/OCR rows and exam response.
   */
  private async showRecordResultPopup(scanId: number, totalScore: number, blankCount = 0): Promise<boolean> {
    if (this.isOfflineMode) return false;
    const studentName = this.getSelectedStudentName();
    const questionCount = Math.max(1, this.getAnswersCount());
    const score = Math.max(0, Math.round(Number(totalScore) || 0));
    try {
      const alert = await this.alertCtrl.create({
        cssClass: 'record-result-alert',
        header: 'Review scan result',
        subHeader: 'Confirm the result before adding it to the gradebook',
        message: [
          `Student: ${studentName || 'Unassigned student'}`,
          `Result: ${score} of ${questionCount} correct`,
          ...(blankCount > 0 ? [`${blankCount} unanswered question${blankCount === 1 ? ' was' : 's were'} scored as incorrect.`] : []),
          'Choose Record result to save this score, or Remove scan to discard it.'
        ].join('\n\n'),
        backdropDismiss: false,
        buttons: [
          {
            text: 'Remove scan',
            role: 'remove',
            cssClass: 'alert-button-danger'
          },
          {
            text: 'Record result',
            role: 'record',
            cssClass: 'alert-button-confirm'
          }
        ]
      });

      await alert.present();
      const dismissal = await alert.onDidDismiss();
      if (this.isOfflineMode) return false;
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
   private async showPrintScorePopup(scanId: number, totalScore: number, blankCount = 0): Promise<void> {
     console.log('Attempting to show print score popup...');
     const studentName = this.getSelectedStudentName();
     const questionCount = Math.max(1, this.getAnswersCount());
     const score = Math.max(0, Math.round(Number(totalScore) || 0));
     
     try {
       const alert = await this.alertCtrl.create({
         cssClass: 'print-score-alert',
         header: 'Score ready to print',
         subHeader: 'Review the result before opening the print dialog',
         message: [
           `Student: ${studentName || 'Unassigned student'}`,
           `Result: ${score} of ${questionCount} correct`,
           ...(blankCount > 0 ? [`${blankCount} unanswered question${blankCount === 1 ? ' was' : 's were'} scored as incorrect.`] : []),
           'A print-ready copy of this scanned sheet will open. Your saved result will not change.'
         ].join('\n\n'),
         backdropDismiss: false,
         buttons: [
           {
             text: 'Not now',
             role: 'cancel',
             cssClass: 'print-score-cancel',
             handler: () => {
               console.log('Print score cancelled');
             }
           },
           {
             text: 'Open print dialog',
             cssClass: 'print-score-confirm',
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
      if (this.isStandaloneAndroid || this.isOfflineMode) {
        const offlineAtStart = this.isOfflineMode;
        const response = await firstValueFrom(this.scanService.getScan(scanId));
        if (offlineAtStart !== this.isOfflineMode) return;
        if (!response?.scan) throw new Error('The saved result could not be loaded.');
        if (this.isStandaloneAndroid) await this.printAndroidScore(response.scan);
        else await this.printOfflineScore(response.scan);
        return;
      }
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
                       @page { size: 8.5in 13in; margin: 0; }
                       html, body { width: 8.5in; height: 13in; margin: 0; padding: 0; background: #fff; }
                       img { display: block; width: 8.5in; height: 13in; }
                       @media print { html, body { width: 8.5in; height: 13in; margin: 0; } img { width: 8.5in; height: 13in; } }
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
      this.showToastMessage(error.error?.message || error?.message || 'Failed to print score');
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
              @page { size: 8.5in 13in; margin: 0; }
              html, body { width: 8.5in; height: 13in; margin: 0; padding: 0; background: #fff; }
              body { display: block; }
              img { display: block; width: 8.5in; height: 13in; }
              @media print { html, body { width: 8.5in; height: 13in; margin: 0; } img { width: 8.5in; height: 13in; } }
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

        this.noteCameraFrameFailure('Camera frame could not be displayed; reconnecting...');
        console.warn('Camera image decode failed:', {
            url: this.cameraStreamUrl,
            baseUrl: this.cameraBaseUrl,
            isActive: this.isScannerActive,
            isPolling: this.isPolling,
            timestamp: new Date().toISOString()
        });
        this.scheduleNextPoll(this.getStreamRetryDelay(), this.streamPollGeneration);
    }

    testCameraDirectly() {
        if (!this.cameraCaptureUrl) {
            this.showToastMessage('Camera capture URL not configured');
            return;
        }

        this.showToastMessage('Testing camera /capture endpoint...');
        console.log('Testing direct Raspberry Pi capture from:', this.cameraCaptureUrl);

        const testUrl = this.cameraCaptureRequestUrl();
        this.http.get(testUrl, {
          headers: this.cameraRequestHeaders(testUrl),
          responseType: 'blob'
        }).pipe(
            timeout(18000)
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
                this.showToastMessage('Camera /capture is not responding. Check the Raspberry Pi camera service.');
            }
        });
    }

    openInBrowser() {
        window.open(
          this.streamFrameBlobUrl || this.cameraCaptureRequestUrl() || this.cameraBaseUrl,
          '_blank'
        );
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
