; Windows installer: after the install folder, a page asks where to keep the AI models (5 to 12 GB), so a small C: drive
; isn't filled. The answer goes to %APPDATA%\Yogurt\models-dir.txt, which the app reads (src/main/paths.ts modelsFolder).
; Not asked on updates (silent), or when models are already somewhere: nothing is ever moved.
!include nsDialogs.nsh
!include LogicLib.nsh

!ifndef BUILD_UNINSTALLER
Var ModelsDir
Var ModelsField

Function modelsPageCreate
  ${If} ${Silent}
    Abort
  ${EndIf}
  ${If} ${FileExists} "$APPDATA\Yogurt\models-dir.txt"
    Abort
  ${EndIf}
  ${If} ${FileExists} "$APPDATA\Yogurt\models\*.*"
    Abort
  ${EndIf}
  StrCpy $ModelsDir "$APPDATA\Yogurt\models"
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 0 100% 36u "Yogurt downloads its AI models once, about 5 to 12 GB. Choose where to keep them. A drive with room to spare is best."
  Pop $0
  ${NSD_CreateDirRequest} 0 44u 76% 13u "$ModelsDir"
  Pop $ModelsField
  ${NSD_CreateBrowseButton} 78% 43u 22% 15u "Browse..."
  Pop $0
  ${NSD_OnClick} $0 modelsBrowse
  nsDialogs::Show
FunctionEnd

Function modelsBrowse
  ${NSD_GetText} $ModelsField $0
  nsDialogs::SelectFolderDialog "Folder for Yogurt's AI models" "$0"
  Pop $0
  ${If} $0 != error
    ${NSD_SetText} $ModelsField "$0"
  ${EndIf}
FunctionEnd

Function modelsPageLeave
  ${NSD_GetText} $ModelsField $ModelsDir
  ${If} $ModelsDir == ""
  ${OrIf} $ModelsDir == "$APPDATA\Yogurt\models"
    Return
  ${EndIf}
  CreateDirectory "$ModelsDir"
  ${IfNot} ${FileExists} "$ModelsDir\*.*"
    MessageBox MB_ICONEXCLAMATION "Yogurt can't use that folder. Pick another one."
    Abort
  ${EndIf}
  CreateDirectory "$APPDATA\Yogurt"
  ; UTF-16 with a byte-order mark, so any folder name survives
  FileOpen $0 "$APPDATA\Yogurt\models-dir.txt" w
  FileWriteWord $0 0xFEFF
  FileWriteUTF16LE $0 "$ModelsDir"
  FileClose $0
FunctionEnd
!endif

!macro customPageAfterChangeDir
  Page custom modelsPageCreate modelsPageLeave
!macroend
