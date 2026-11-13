@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22 or newer is required. https://nodejs.org/
  pause
  exit /b 1
)
node -e "if (Number(process.versions.node.split('.')[0]) < 22) process.exit(1)"
if errorlevel 1 (
  echo Node.js 22 or newer is required. https://nodejs.org/
  pause
  exit /b 1
)
node --input-type=module -e "import {getMediaCapabilities} from './server/media.mjs'; const m = await getMediaCapabilities(); process.exit(m.conversion ? m.transcription ? 0 : 2 : 1)"
set "OURDAYS_MEDIA_SETUP=%ERRORLEVEL%"
if "%OURDAYS_MEDIA_SETUP%"=="1" (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "server\media-setup-ffmpeg.ps1"
  if errorlevel 1 goto :setup_failed
)
if not "%OURDAYS_MEDIA_SETUP%"=="0" (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "server\media-setup-whisper.ps1"
  if errorlevel 1 goto :setup_failed
)
echo Open the address printed by the server in your browser.
echo Keep this window open while using Still.
node server\start.mjs %*
if errorlevel 1 pause
exit /b %ERRORLEVEL%

:setup_failed
echo Setup failed. See README.md for manual dependency setup.
pause
exit /b 1
