@echo off
setlocal

set "ACADCHECK_BROWSER="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "ACADCHECK_BROWSER=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined ACADCHECK_BROWSER if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "ACADCHECK_BROWSER=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not defined ACADCHECK_BROWSER if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set "ACADCHECK_BROWSER=%LocalAppData%\Google\Chrome\Application\chrome.exe"
if not defined ACADCHECK_BROWSER if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "ACADCHECK_BROWSER=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not defined ACADCHECK_BROWSER if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "ACADCHECK_BROWSER=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"

if not defined ACADCHECK_BROWSER (
  echo Chrome or Microsoft Edge could not be found.
  echo Install one of them, then run this launcher again.
  pause
  exit /b 1
)

echo Starting AcadCheck with silent kiosk printing.
echo Printed scores will go to the current Windows default printer.
start "AcadCheck Auto Print" "%ACADCHECK_BROWSER%" --kiosk-printing --no-first-run --user-data-dir="%TEMP%\AcadCheckKioskProfile" --app="http://localhost:8100/scanner"
endlocal
