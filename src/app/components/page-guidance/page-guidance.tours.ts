export interface ProductTourStep {
  target: string;
  title: string;
  description: string;
  action: string;
  detail?: string;
  interactionEvent?: 'click' | 'input' | 'ionChange' | 'ionInput';
}

export interface ProductTour {
  name: string;
  steps: ProductTourStep[];
}

export const PAGE_TOURS: Record<string, ProductTour> = {
  dashboard: {
    name: 'Dashboard',
    steps: [
      { target: '.dashboard-container .stat-grid', title: 'Your live overview', description: 'These cards summarize the learners, keys, scans, and records currently available.', action: 'Compare the cards and identify the area needing attention.' },
      { target: '.dashboard-container .realtime-badge', title: 'Live connection status', description: 'This indicator tells you whether dashboard data is being refreshed from the active service.', action: 'Check the status before relying on newly submitted scans.' },
      { target: '.dashboard-container .chart-section', title: 'See performance patterns', description: 'Charts turn recent assessment activity into trends that are easier to compare.', action: 'Hover or tap a chart value to inspect it.', interactionEvent: 'click' },
      { target: '.dashboard-container .progress-section', title: 'Follow current progress', description: 'Use this area to spot incomplete work and items that deserve follow-up.', action: 'Review the progress list, then open the related feature for detail.' }
    ]
  },
  students: {
    name: 'Students',
    steps: [
      { target: '.students-content .stats-section', title: 'Know your roster', description: 'The summary keeps classroom and student totals visible as the roster grows.', action: 'Confirm the totals match what you expect.' },
      { target: '.students-content .action-section', title: 'Add learners and classrooms', description: 'Create the classroom structure first, then add each learner to the correct group.', action: 'Open an add action to see the required information.', interactionEvent: 'click' },
      { target: '.students-content .classrooms-management', title: 'Organize classrooms', description: 'Classroom controls keep sections separated and make later filtering easier.', action: 'Open a classroom to review its learners.', interactionEvent: 'click' },
      { target: '.students-content .filter-section', title: 'Find someone quickly', description: 'Search and classroom filters narrow the roster without changing saved data.', action: 'Enter a name or change a filter.', interactionEvent: 'ionChange' },
      { target: '.students-content .students-list', title: 'Open the learner record', description: 'Each student row leads to the identity used to attach scans and build learning history.', action: 'Select a learner when you want to inspect or update them.' }
    ]
  },
  'answer-key': {
    name: 'Answer Keys',
    steps: [
      { target: '.answer-key-content .workspace-hero', title: 'Keys drive scoring', description: 'AcadCheck compares every detected response with the selected answer key.', action: 'Check the subject and assessment context before editing.' },
      { target: '.answer-key-content .action-section', title: 'Create a key', description: 'Set the question count and correct choice for every item. The sheet and key must have matching lengths.', action: 'Open Create Answer Key to begin.', interactionEvent: 'click' },
      { target: '.answer-key-content .keys-section', title: 'Choose the right key', description: 'Saved keys can be reviewed before scanning so papers are graded against the intended assessment.', action: 'Inspect a saved key and its question count.' },
      { target: '.answer-key-content .key-actions', title: 'Maintain your keys', description: 'Use these actions to review, edit, or remove a key. Changes affect future grading.', action: 'Open a non-destructive review or edit action.' }
    ]
  },
  scanner: {
    name: 'Scanner',
    steps: [
      { target: '[data-scanner-guide=offline-status]', title: 'Offline-ready scanning', description: 'The mobile scanner processes sheets on the device, so grading can continue without an internet connection.', action: 'Confirm the offline engine reports ready before starting.' },
      { target: '[data-scanner-guide=scan-mode]', title: 'Choose the scan workflow', description: 'Use camera mode for live capture or upload mode for an existing sheet image.', action: 'Select the workflow you want to use.', interactionEvent: 'ionChange' },
      { target: '[data-scanner-guide=scan-config]', title: 'Select the scoring context', description: 'The answer key determines the expected question count and correct responses.', action: 'Select the answer key for this paper.', interactionEvent: 'ionChange' },
      { target: '[data-scanner-guide=camera-source], [data-scanner-guide=upload-source]', title: 'Provide the whole sheet', description: 'Keep all page edges, answer rows, QR marker, and sequence boxes visible. Flat paper and even lighting improve registration.', action: 'Start the camera or choose a clear image.', interactionEvent: 'click' },
      { target: '[data-scanner-guide=camera-feedback], [data-scanner-guide=upload-area]', title: 'Follow live detection', description: 'Resolved rows measure bubble detection. Stable confirmation requires matching full-sheet readings instead of accepting one lucky frame.', action: 'Hold the sheet still while AcadCheck confirms the same result.' },
      { target: '[data-scanner-guide=offline-review], [data-scanner-guide=offline-grade]', title: 'Review before saving', description: 'AcadCheck shows uncertain rows and the detected student sequence so you can correct anything ambiguous before grading.', action: 'Verify the sequence and responses, then grade when everything is correct.' }
    ]
  },
  results: {
    name: 'Results & Analytics',
    steps: [
      { target: '.results-content .workspace-hero', title: 'From scans to evidence', description: 'Results combine scores, item responses, and scan quality into class-level teaching signals.', action: 'Start with the assessment context and result count.' },
      { target: '.results-content .filters-card', title: 'Define the evidence set', description: 'Search and filters change which attempts contribute to the summaries and question analysis.', action: 'Change a filter and watch the view recalculate.', interactionEvent: 'ionChange' },
      { target: '.results-content .stats-section', title: 'How scores are summarized', description: 'The average is the rounded mean of visible percentage values. The current grade bands are A at 36+, B at 32+, C at 24+, D at 20+, and F below 20; Passed begins at 20.', action: 'Compare the average, pass count, and grade mix.', detail: 'These thresholds are the configured 40-point grading contribution bands; filters determine which visible attempts are included.' },
      { target: '.results-content .question-insights', title: 'Question-by-question analysis', description: 'For every item, AcadCheck measures correct, wrong, and blank rates plus answer-choice distribution and the most common distractor.', action: 'Select a question to inspect its response pattern.', interactionEvent: 'click', detail: 'The engine also calculates a Wilson 95% confidence interval, which avoids overstating certainty when only a few papers are available.' },
      { target: '.results-content .analysis-brief, .results-content .insights-heading', title: 'How diagnostics are assigned', description: 'Rules combine correctness, blanks, dominant distractors, discrimination, and scan confidence to label mastery, developing skill, learning gaps, shared misconceptions, possible item issues, or scan-quality concerns.', action: 'Read the diagnostic reason beside a flagged item.', detail: 'Discrimination compares stronger and weaker performers. A negative or weak value can indicate an ambiguous key or item, but it is evidence for review—not an automatic verdict.' },
      { target: '.results-content .priority-panel', title: 'Prioritize intervention', description: 'Priority is ordered by risk score and then by number of attempts, bringing the strongest actionable signal forward.', action: 'Open the highest-priority item first.', detail: 'Cold-start grouping separates on-track, monitor, and review patterns. When reviewed labels exist, supervised classification can refine that grouping.' },
      { target: '.results-content .recommendation-card', title: 'Interpret recommendations safely', description: 'Recommendations translate the detected pattern into a next teaching action while preserving the underlying evidence.', action: 'Compare the suggestion with the item evidence.', detail: 'The algorithm does not read the wording of the question. Teacher review is still required to distinguish a learning gap from an unclear item or answer key.' },
      { target: '.results-content .results-section', title: 'Trace every conclusion', description: 'The result list is the source record: open an attempt to verify its score, responses, and confidence before acting on a class trend.', action: 'Open a result and confirm the supporting scan details.' }
    ]
  },
  records: {
    name: 'Records',
    steps: [
      { target: '.records-content .workspace-hero', title: 'Follow learning over time', description: 'Records connect separate assessments to the same student instead of treating each scan in isolation.', action: 'Check the current record scope.' },
      { target: '.records-content .filters-card', title: 'Narrow the history', description: 'Use search and filters to focus on a learner, classroom, or assessment period.', action: 'Apply a filter to the record set.', interactionEvent: 'ionChange' },
      { target: '.records-content .bulk-toolbar', title: 'Work with selected records', description: 'Bulk actions apply to every selected row, so verify the selection count before continuing.', action: 'Select records only when you intend to manage them together.' },
      { target: '.records-content .student-link, .records-content .records-table', title: 'Open a student timeline', description: 'A learner record exposes repeated scores so you can distinguish a pattern from a single unusual attempt.', action: 'Open a student and compare recent assessments.', interactionEvent: 'click' },
      { target: '.records-content .workspace-hero-action', title: 'Export when needed', description: 'Export creates a portable copy of the currently available records for reporting or review.', action: 'Review the visible scope before exporting.' }
    ]
  },
  profile: {
    name: 'Profile',
    steps: [
      { target: '.profile-content .profile-hero', title: 'Your AcadCheck identity', description: 'Profile details keep the workspace recognizable and associate activity with the correct account.', action: 'Confirm your name and account details.' },
      { target: '.profile-content .stats-grid', title: 'Personal activity summary', description: 'These totals provide a quick picture of your recent AcadCheck work.', action: 'Review the counts for unexpected changes.' },
      { target: '.profile-content .account-panel', title: 'Maintain account details', description: 'Use the account panel to keep editable information accurate.', action: 'Review the fields before saving any change.' },
      { target: '.profile-content .actions-panel', title: 'Help is always available', description: 'System Guide and other account actions remain available here after this tour ends.', action: 'Return here whenever you want to revisit guidance.' }
    ]
  },
  admin: {
    name: 'Administration',
    steps: [
      { target: '.admin-container .admin-hero', title: 'System oversight', description: 'Administration brings user access and platform activity into one protected workspace.', action: 'Confirm you are working in the intended environment.' },
      { target: '.admin-container .admin-tabs', title: 'Move between admin areas', description: 'Tabs separate overview, user, and operational tools so changes remain deliberate.', action: 'Select a tab to explore its tools.', interactionEvent: 'click' },
      { target: '.admin-container .overview-grid', title: 'Watch system health', description: 'Overview cards surface counts and conditions that may require an administrator’s attention.', action: 'Check for unusual totals or warnings.' },
      { target: '.admin-container .tab-content, .admin-container .interactive-card', title: 'Manage with context', description: 'Open an item to inspect its current state before changing roles, access, or platform data.', action: 'Review an item without committing a destructive action.' },
      { target: '.admin-container .refresh-button', title: 'Refresh before deciding', description: 'Reload current data before making an administrative decision based on a changing system.', action: 'Refresh the admin view now.', interactionEvent: 'click' }
    ]
  }
};
