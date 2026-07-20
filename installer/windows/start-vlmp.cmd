@echo off
setlocal EnableExtensions
rem VLMP launcher (console mode). %~dp0 ends with a backslash.
rem Runs elevated so console and service mode share one locked-down data dir.
rem Note: a session-only VLMP_DATA_DIR does not survive the elevation hop --
rem set custom data dirs machine-wide (setx /M VLMP_DATA_DIR ...).

rem Admin check via fltmc (always present, admin-only) -- "net session" also
rem fails when the Server service is stopped, which would relaunch forever.
fltmc >nul 2>&1
if errorlevel 1 (
  if "%~1"=="--elevated" (
    echo Could not obtain administrator rights.
    pause
    exit /b 1
  )
  echo Requesting administrator rights...
  powershell -NoProfile -Command "Start-Process -Verb RunAs -FilePath \"%~f0\" -ArgumentList '--elevated'"
  exit /b
)

set "VLMP_HOME=%~dp0"

if defined VLMP_DATA_DIR goto data_ready
set "VLMP_DATA_DIR=%ProgramData%\vlmp"
if not exist "%VLMP_DATA_DIR%" mkdir "%VLMP_DATA_DIR%"
rem %ProgramData% lets standard users CREATE files by inherited ACE -- a planted
rem vlmp.env there would feed VLMP_FFMPEG_PATH to a privileged process. Lock the
rem default dir to SYSTEM + Administrators (SIDs: locale-independent). Fail
rem CLOSED: an unlocked dir must not be used silently. A custom VLMP_DATA_DIR
rem is the operator's responsibility.
rem Grant on the DIRECTORY only -- never /t the (OI)(CI) grants onto files:
rem /inheritance:r strips a file's inherited ACEs but the inheritance-flagged
rem re-grant does not stick on files, leaving an EMPTY DACL that denies even
rem admins (observed: jwt.secret EPERM on the second launch). Children get
rem their ACLs rebuilt by inheritance via /reset below, which also heals any
rem file already stripped by older launcher versions.
takeown /f "%VLMP_DATA_DIR%" /a /r /d y >nul 2>&1
icacls "%VLMP_DATA_DIR%" /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" >nul 2>&1
if errorlevel 1 (
  echo ERROR: could not lock down "%VLMP_DATA_DIR%" permissions ^(non-NTFS volume?^).
  echo A world-writable config file there can redirect VLMP to a malicious FFmpeg.
  echo Fix the volume/permissions, or set VLMP_DATA_DIR to an NTFS location.
  pause
  exit /b 1
)
rem Errors swallowed: on a fresh (empty) dir there is nothing to reset. A real
rem reset failure on jwt.secret is caught by the read-back gate below.
icacls "%VLMP_DATA_DIR%\*" /reset /t /c /q >nul 2>&1
:data_ready
if not exist "%VLMP_DATA_DIR%" mkdir "%VLMP_DATA_DIR%"

rem First run: generate a persistent JWT secret. Written to a temp name first --
rem the shell creates the redirect target BEFORE node runs, and a 0-byte
rem jwt.secret would otherwise stick and hard-fail every later start.
rem A leftover 0-byte secret (interrupted creation) is regenerated: the server
rem refuses to boot on it anyway, so rotation is strictly better than a wall.
for %%A in ("%VLMP_DATA_DIR%\jwt.secret") do if "%%~zA"=="0" del "%VLMP_DATA_DIR%\jwt.secret"
if not exist "%VLMP_DATA_DIR%\jwt.secret" (
  "%VLMP_HOME%node\node.exe" -e "process.stdout.write(require('node:crypto').randomBytes(48).toString('hex'))" 1>"%VLMP_DATA_DIR%\jwt.secret.tmp" && move /y "%VLMP_DATA_DIR%\jwt.secret.tmp" "%VLMP_DATA_DIR%\jwt.secret" >nul
)
if exist "%VLMP_DATA_DIR%\jwt.secret.tmp" del "%VLMP_DATA_DIR%\jwt.secret.tmp"
if not defined VLMP_JWT_SECRET set "VLMP_JWT_SECRET_FILE=%VLMP_DATA_DIR%\jwt.secret"

rem Read-back gate: fail HERE with the ACL on screen instead of letting node
rem die on EPERM with a stack trace. goto-style (no paren block) so paths
rem containing ) -- e.g. "Program Files (x86)" -- cannot break parsing.
if not defined VLMP_JWT_SECRET_FILE goto secret_ok
type "%VLMP_JWT_SECRET_FILE%" >nul 2>&1
if not errorlevel 1 goto secret_ok
echo ERROR: cannot read "%VLMP_JWT_SECRET_FILE%" -- the server cannot start without it.
echo Current ACL of the file:
icacls "%VLMP_JWT_SECRET_FILE%"
echo Repair from an elevated prompt:
echo   icacls "%VLMP_DATA_DIR%\*" /reset /t /c
pause
exit /b 1
:secret_ok

echo VLMP data dir: %VLMP_DATA_DIR%
echo Optional config file: %VLMP_DATA_DIR%\vlmp.env  (template: "%VLMP_HOME%vlmp.env.example")
echo Default address: http://localhost:8080
"%VLMP_HOME%node\node.exe" "%VLMP_HOME%server\src\index.js"
pause
