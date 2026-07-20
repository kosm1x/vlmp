@echo off
setlocal EnableExtensions
rem Stops and removes the VLMP Windows service. Run as Administrator.

fltmc >nul 2>&1
if errorlevel 1 (
  echo This script must be run as Administrator.
  pause
  exit /b 1
)

set "NSSM=%~dp0nssm\nssm.exe"
"%NSSM%" stop VLMP
"%NSSM%" remove VLMP confirm
echo VLMP service removed. Data in %ProgramData%\vlmp is untouched.
