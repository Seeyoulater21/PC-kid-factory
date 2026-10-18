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

; A running copy holds node.exe open; stop only our own copy before replacing files.
!macro StopApp
  nsExec::Exec `powershell -NoProfile -Command "Get-Process node -ErrorAction SilentlyContinue | Where-Object { $$_.Path -eq '$INSTDIR\runtime\node.exe' } | Stop-Process -Force"`
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
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "${UNINST_KEY}"
SectionEnd
