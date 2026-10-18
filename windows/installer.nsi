; KidFactory-Setup-<version>.exe: per-user install (no admin), Desktop + Start menu shortcuts, uninstaller.
; Built by scripts/make-win.sh (makensis -DSTAGE=<stage folder> -DVERSION=<x.y.z> -DOUT=<setup.exe>).
; The data folder (%USERPROFILE%\KidFactory: key, episodes, music) is never touched by install or uninstall.
Unicode true
!include MUI2.nsh

!define APP "Kid Factory"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\KidFactory"

Name "${APP}"
OutFile "${OUT}"
InstallDir "$LOCALAPPDATA\Programs\KidFactory"
RequestExecutionLevel user
SetCompressor /SOLID lzma
ManifestDPIAware true

!define MUI_ICON "icon.ico"
!define MUI_UNICON "icon.ico"
!define MUI_FINISHPAGE_RUN "$INSTDIR\KidFactory.exe"
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "Thai"

; A running copy holds node/ffmpeg/ffprobe open; stop only our own runtime before replacing files.
; Matched by folder name, not $INSTDIR, so quotes in a user name cannot break the command. WMI, because this
; 32-bit installer starts a 32-bit PowerShell, which cannot read the path of the 64-bit node.exe.
!macro StopApp
  nsExec::Exec `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -like '*\KidFactory\runtime\*' } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force }"`
  Pop $0
!macroend

Section
  !insertmacro StopApp
  RMDir /r "$INSTDIR\app"
  SetOutPath "$INSTDIR"
  File /r "${STAGE}/*"
  CreateShortcut "$DESKTOP\${APP}.lnk" "$INSTDIR\KidFactory.exe" "" "$INSTDIR\icon.ico"
  CreateShortcut "$SMPROGRAMS\${APP}.lnk" "$INSTDIR\KidFactory.exe" "" "$INSTDIR\icon.ico"
  WriteUninstaller "$INSTDIR\uninstall.exe"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "${APP}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\icon.ico"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
SectionEnd

Section Uninstall
  !insertmacro StopApp
  Delete "$DESKTOP\${APP}.lnk"
  Delete "$SMPROGRAMS\${APP}.lnk"
  ; only what the installer put there, in case the folder was chosen by hand
  RMDir /r "$INSTDIR\app"
  RMDir /r "$INSTDIR\runtime"
  Delete "$INSTDIR\KidFactory.exe"
  Delete "$INSTDIR\icon.ico"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"
  RMDir /r "$LOCALAPPDATA\KidFactory" ; window profile and launcher log, not the data folder
  DeleteRegKey HKCU "${UNINST_KEY}"
SectionEnd
