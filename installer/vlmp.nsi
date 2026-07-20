; VLMP Windows installer. Built from Linux/macOS via `installer/build.sh`
; (which stages payload into installer/staging/app and invokes makensis with
; cwd = installer/, so all relative paths below resolve from this directory).

!include "MUI2.nsh"

!ifndef VERSION
  !define VERSION "0.0.0"
!endif

Name "VLMP Media Server"
OutFile "dist/vlmp-setup-${VERSION}-win-x64.exe"
Unicode True
InstallDir "$PROGRAMFILES64\VLMP"
InstallDirRegKey HKLM "Software\VLMP" "InstallDir"
RequestExecutionLevel admin
SetCompressor /SOLID lzma

!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\start-vlmp.cmd"
!define MUI_FINISHPAGE_RUN_TEXT "Start VLMP now (console window)"
!define MUI_FINISHPAGE_LINK "Open VLMP in your browser (after starting)"
!define MUI_FINISHPAGE_LINK_LOCATION "http://localhost:8080"
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Section "VLMP Server (required)" SEC_CORE
  SectionIn RO

  ; Upgrading over a running service would hit locked files — stop it first
  ; (best effort; no-op on fresh installs).
  IfFileExists "$INSTDIR\nssm\nssm.exe" 0 no_service
    ExecWait '"$INSTDIR\nssm\nssm.exe" stop VLMP'
    Sleep 2000 ; let the OS release node.exe handles so the probe below doesn't false-positive
  no_service:

  ; A still-running CONSOLE instance also holds node.exe locked — fail cleanly
  ; up front instead of dying mid-copy with a partial install. (File /r below
  ; rewrites node.exe anyway, so the probe deletion is harmless.)
  IfFileExists "$INSTDIR\node\node.exe" 0 not_running
    ClearErrors
    Delete "$INSTDIR\node\node.exe"
    IfErrors 0 not_running
      IfSilent probe_abort ; a modal MessageBox would hang an unattended /S install
        MessageBox MB_ICONSTOP "VLMP appears to be running. Close its console window (or stop the service) and run the installer again."
      probe_abort:
      SetErrorLevel 5
      Abort "VLMP appears to be running - close it and run the installer again."
  not_running:

  SetOutPath "$INSTDIR"
  File /r "staging/app/*"

  WriteUninstaller "$INSTDIR\uninstall.exe"
  WriteRegStr HKLM "Software\VLMP" "InstallDir" "$INSTDIR"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\VLMP" "DisplayName" "VLMP Media Server"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\VLMP" "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\VLMP" "Publisher" "VLMP"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\VLMP" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\VLMP" "NoModify" 1
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\VLMP" "NoRepair" 1

  CreateDirectory "$SMPROGRAMS\VLMP"
  CreateShortcut "$SMPROGRAMS\VLMP\VLMP Server.lnk" "$INSTDIR\start-vlmp.cmd"
  WriteINIStr "$SMPROGRAMS\VLMP\Open VLMP.url" "InternetShortcut" "URL" "http://localhost:8080"
  CreateShortcut "$SMPROGRAMS\VLMP\Install VLMP service.lnk" "$INSTDIR\install-service.cmd"
  CreateShortcut "$SMPROGRAMS\VLMP\Remove VLMP service.lnk" "$INSTDIR\remove-service.cmd"
  CreateShortcut "$SMPROGRAMS\VLMP\Uninstall VLMP.lnk" "$INSTDIR\uninstall.exe"
SectionEnd

Section "Windows Firewall rule (TCP 8080)" SEC_FW
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="VLMP" dir=in action=allow protocol=TCP localport=8080'
  Pop $0
SectionEnd

Section "Install FFmpeg via winget (~100 MB download)" SEC_FFMPEG
  DetailPrint "Installing FFmpeg via winget (best effort)..."
  nsExec::ExecToLog 'winget install -e --id Gyan.FFmpeg --accept-source-agreements --accept-package-agreements --disable-interactivity'
  Pop $0
  StrCmp $0 "0" ffmpeg_done
    DetailPrint "winget FFmpeg install did not complete (code $0)."
    DetailPrint "Install FFmpeg manually — VLMP warns at boot while it is missing."
  ffmpeg_done:
SectionEnd

Section /o "Desktop shortcut" SEC_DESKTOP
  CreateShortcut "$DESKTOP\VLMP.lnk" "$INSTDIR\start-vlmp.cmd"
SectionEnd

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_CORE} "Server, web client, portable Node.js runtime and NSSM service helper."
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_FW} "Allow LAN devices to reach VLMP on TCP 8080."
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_FFMPEG} "FFmpeg is required for scanning and transcoding. Skip if already installed."
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_DESKTOP} "Shortcut to start the VLMP server."
!insertmacro MUI_FUNCTION_DESCRIPTION_END

Section "Uninstall"
  ; Refuse to recursively wipe a directory that isn't actually a VLMP install
  ; (protects against a mangled InstallDir registry value / pathological dir).
  IfFileExists "$INSTDIR\start-vlmp.cmd" un_ok
    IfSilent un_guard_abort ; no modal in silent uninstalls
      MessageBox MB_ICONSTOP "VLMP files not found in $INSTDIR - refusing to remove it."
    un_guard_abort:
    SetErrorLevel 5
    Abort "VLMP files not found in $INSTDIR - refusing to remove it."
  un_ok:
  IfFileExists "$INSTDIR\nssm\nssm.exe" 0 un_no_service
    ExecWait '"$INSTDIR\nssm\nssm.exe" stop VLMP'
    ExecWait '"$INSTDIR\nssm\nssm.exe" remove VLMP confirm'
  un_no_service:
  ExecWait 'netsh advfirewall firewall delete rule name="VLMP"'

  Delete "$DESKTOP\VLMP.lnk"
  Delete "$SMPROGRAMS\VLMP\*.*"
  RMDir "$SMPROGRAMS\VLMP"
  RMDir /r "$INSTDIR"

  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\VLMP"
  DeleteRegKey HKLM "Software\VLMP"

  ; Deliberately kept: library DB, settings, backups.
  DetailPrint "VLMP data kept at C:\ProgramData\vlmp — delete manually if you want a full wipe."
SectionEnd
