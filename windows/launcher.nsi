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
  ExecShell "" '"$EXEDIR\runtime\node.exe"' '"$EXEDIR\app\src\launcher.mjs"' SW_HIDE
SectionEnd
