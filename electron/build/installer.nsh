; JSE installer additions — included by electron-builder (package.json → build.nsis.include).
;
; MuseScore (.mscz .mscx) and NoteWorthy Composer (.nwc .nwctxt) files: JSE is offered under
; "Open with" / "연결 프로그램", but it never takes the default program away from MuseScore or NWC.
; (.ssnap, .musx and .ftmx are registered as JSE's own types by build.fileAssociations.)

!macro customInstall
  WriteRegStr SHCTX "Software\Classes\JSE.ScoreFile" "" "악보 파일"
  WriteRegStr SHCTX "Software\Classes\JSE.ScoreFile\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHCTX "Software\Classes\JSE.ScoreFile\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  WriteRegStr SHCTX "Software\Classes\.mscz\OpenWithProgids" "JSE.ScoreFile" ""
  WriteRegStr SHCTX "Software\Classes\.mscx\OpenWithProgids" "JSE.ScoreFile" ""
  WriteRegStr SHCTX "Software\Classes\.nwc\OpenWithProgids" "JSE.ScoreFile" ""
  WriteRegStr SHCTX "Software\Classes\.nwctxt\OpenWithProgids" "JSE.ScoreFile" ""
!macroend

!macro customUnInstall
  DeleteRegValue SHCTX "Software\Classes\.mscz\OpenWithProgids" "JSE.ScoreFile"
  DeleteRegValue SHCTX "Software\Classes\.mscx\OpenWithProgids" "JSE.ScoreFile"
  DeleteRegValue SHCTX "Software\Classes\.nwc\OpenWithProgids" "JSE.ScoreFile"
  DeleteRegValue SHCTX "Software\Classes\.nwctxt\OpenWithProgids" "JSE.ScoreFile"
  DeleteRegKey SHCTX "Software\Classes\JSE.ScoreFile"
!macroend
