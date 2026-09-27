# Blank answer sheets and classroom rosters

The Answer Key page prints the supplied new-entry-answer-sheet.docx blank form,
with two copies on 8.5 x 13-inch long bond. It never shades saved correct answers.
Use 100% scale, long-bond paper and no browser headers/footers in the print dialog.
The matching DOCX remains available at assets/answer-sheet/answer-sheet.docx.
Online backend downloads preserve the same source document byte for byte.

Each classroom has Print student list. It prints all students in that classroom
in sequence order, independently of the current search filter, with student
number, first name, middle initial, last name and gender. No email or phone is printed.

Bulk import example: John Reelan E. Altobar | Male
First name: John Reelan; middle initial: E.; last name: Altobar.
A dotted single letter separates the given names from the one-word surname.
Ambiguous lines must be corrected in the import preview before saving.
Existing database middle_name fields remain compatible; displayed labels and
export column headings now say Middle Initial. Existing records are not renamed.

Blank sheets and rosters use browser/Android document print dialogs. The direct
Epson L120 score auto-print flow is unchanged. Android update: code 35,
version 1.2.28-forms.1, dist/AcadCheck-answer-sheet-student-list.apk.

Validation: reference rendered in Word and visually checked; source DOCX hash
verified; blank-form backend test; nine frontend name/roster/routing tests;
Android unit tests and production builds. Browser-plugin interactive validation
was unavailable because its process failed during Windows sandbox startup.
