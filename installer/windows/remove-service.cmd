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
if not exist "%NSSM%" (
  echo ERROR: "%NSSM%" not found -- cannot remove the service from here.
  echo If VLMP was installed elsewhere, run remove-service.cmd from that folder.
  pause
  exit /b 1
)
rem stop may legitimately fail when the service is not running -- ignore it.
"%NSSM%" stop VLMP
"%NSSM%" remove VLMP confirm
if errorlevel 1 (
  echo ERROR: could not remove the VLMP service ^(is it installed?^).
  echo Check: sc query VLMP
  pause
  exit /b 1
)
echo VLMP service removed. Data in %ProgramData%\vlmp is untouched.
