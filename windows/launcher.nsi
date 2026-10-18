; KidFactory.exe: the desktop icon's target. Starts the Node launcher with no console window, then exits.
; Built by scripts/make-win.sh (makensis -DSTAGE=<stage folder>).
Unicode true
Name "Kid Factory"
OutFile "${STAGE}/KidFactory.exe"
Icon "icon.ico"
RequestExecutionLevel user
SilentInstall silent
ManifestDPIAware true

Section
  ; an interrupted update may have left the app folder in the update area: put it back first
  IfFileExists "$EXEDIR\app\src\launcher.mjs" +3
  IfFileExists "$LOCALAPPDATA\KidFactory\update\old\src\launcher.mjs" 0 +2
  Rename "$LOCALAPPDATA\KidFactory\update\old" "$EXEDIR\app"
  ExecShell "" '"$EXEDIR\runtime\node.exe"' '"$EXEDIR\app\src\launcher.mjs"' SW_HIDE
SectionEnd
