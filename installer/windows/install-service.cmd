@echo off
setlocal EnableExtensions
rem Installs VLMP as a Windows service via the bundled NSSM. Run as Administrator.

rem Admin check via fltmc -- "net session" also fails when the Server service
rem is stopped, giving a false "not elevated".
fltmc >nul 2>&1
if errorlevel 1 (
  echo This script must be run as Administrator.
  pause
  exit /b 1
)

set "VLMP_HOME=%~dp0"
set "NSSM=%VLMP_HOME%nssm\nssm.exe"
set "DATA=%ProgramData%\vlmp"

if not exist "%DATA%" mkdir "%DATA%"
rem %ProgramData% lets standard users CREATE files by inherited ACE -- a planted
rem vlmp.env would feed VLMP_FFMPEG_PATH to the SYSTEM service. Lock the dir to
rem SYSTEM + Administrators (SIDs: locale-independent).
rem Grant on the DIRECTORY only -- never /t the (OI)(CI) grants onto files:
rem /inheritance:r strips a file's inherited ACEs but the inheritance-flagged
rem re-grant does not stick on files, leaving an EMPTY DACL that denies even
rem admins/SYSTEM. Children get clean inherited ACLs via /reset below.
takeown /f "%DATA%" /a /r /d y >nul 2>&1
icacls "%DATA%" /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" >nul 2>&1
if errorlevel 1 (
  echo ERROR: could not lock down "%DATA%" permissions ^(non-NTFS volume?^).
  echo Refusing to install a SYSTEM service reading config from an unprotected dir.
  pause
  exit /b 1
)
rem Errors swallowed: on a fresh (empty) dir there is nothing to reset. A real
rem reset failure on jwt.secret is caught by the read-back gate below.
icacls "%DATA%\*" /reset /t /c /q >nul 2>&1
if not exist "%DATA%\logs" mkdir "%DATA%\logs"
rem Secret goes to a temp name first -- the redirect target is created BEFORE
rem node runs, and a 0-byte jwt.secret would stick and hard-fail every start.
rem A leftover 0-byte secret (interrupted creation) is regenerated: the server
rem refuses to boot on it anyway, so rotation is strictly better than a wall.
for %%A in ("%DATA%\jwt.secret") do if "%%~zA"=="0" del "%DATA%\jwt.secret"
if not exist "%DATA%\jwt.secret" (
  "%VLMP_HOME%node\node.exe" -e "process.stdout.write(require('node:crypto').randomBytes(48).toString('hex'))" 1>"%DATA%\jwt.secret.tmp" && move /y "%DATA%\jwt.secret.tmp" "%DATA%\jwt.secret" >nul
)
if exist "%DATA%\jwt.secret.tmp" del "%DATA%\jwt.secret.tmp"

rem Read-back gate: fail HERE with the ACL on screen instead of installing a
rem service that dies on EPERM at every start. goto-style (no paren block) so
rem paths containing ) cannot break parsing.
type "%DATA%\jwt.secret" >nul 2>&1
if not errorlevel 1 goto secret_ok
echo ERROR: cannot read "%DATA%\jwt.secret" -- the service cannot start without it.
echo Current ACL of the file:
icacls "%DATA%\jwt.secret"
echo Repair from an elevated prompt:
echo   icacls "%DATA%\*" /reset /t /c
pause
exit /b 1
:secret_ok

rem The tripled quotes wrap the script path in literal quotes inside the
rem service's command line (needed because the install dir contains spaces).
"%NSSM%" install VLMP "%VLMP_HOME%node\node.exe" """%VLMP_HOME%server\src\index.js"""
if errorlevel 1 (
  echo NSSM install failed ^(is the service already installed? run remove-service.cmd first^).
  exit /b 1
)
rem "%VLMP_HOME%." -- the trailing dot stops the final backslash from escaping the closing quote.
"%NSSM%" set VLMP DisplayName "VLMP Media Server"
"%NSSM%" set VLMP Description "Very Light Media Player server"
"%NSSM%" set VLMP AppDirectory "%VLMP_HOME%."
"%NSSM%" set VLMP AppEnvironmentExtra "VLMP_DATA_DIR=%DATA%" "VLMP_JWT_SECRET_FILE=%DATA%\jwt.secret"
"%NSSM%" set VLMP AppStdout "%DATA%\logs\out.log"
"%NSSM%" set VLMP AppStderr "%DATA%\logs\err.log"
"%NSSM%" set VLMP AppRotateFiles 1
"%NSSM%" set VLMP AppRotateBytes 10485760
"%NSSM%" set VLMP Start SERVICE_AUTO_START
"%NSSM%" start VLMP
echo.
echo VLMP service installed and started.
echo   Web UI:  http://localhost:8080
echo   Config:  %DATA%\vlmp.env   (template: "%VLMP_HOME%vlmp.env.example"; restart the service after edits)
echo   Logs:    %DATA%\logs
