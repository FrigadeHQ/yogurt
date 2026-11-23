; Windows installer additions (electron-builder's nsis.include).
;
; An update runs the old version's uninstaller first. When that crashed (#126: 0xC0000374, heap corruption, in the old
; uninstaller itself), electron-builder's installer stopped with "Failed to uninstall old application files" and the
; person had to download the installer by hand. Every file this version needs is written over the old ones next, and
; the app data is never touched (deleteAppDataOnUninstall is off), so a failed old uninstaller is noted and the install
; carries on. Both macros: a per-machine and a per-user install are checked separately.
!include LogicLib.nsh

!macro customUnInstallCheck
  ${If} ${Errors}
    DetailPrint `The old version's uninstaller did not start; installing over it.`
  ${ElseIf} $R0 != 0
    DetailPrint `The old version's uninstaller failed (code $R0); installing over it.`
  ${EndIf}
  ClearErrors
!macroend

!macro customUnInstallCheckCurrentUser
  ${If} ${Errors}
    DetailPrint `The old version's uninstaller did not start; installing over it.`
  ${ElseIf} $R0 != 0
    DetailPrint `The old version's uninstaller failed (code $R0); installing over it.`
  ${EndIf}
  ClearErrors
!macroend

; After the install folder, a page asks where to keep the AI models (5 to 12 GB), so a small C: drive
; isn't filled. The answer goes to %APPDATA%\Yogurt\models-dir.txt, which the app reads (src/main/paths.ts modelsFolder).
; Not asked on updates (silent), or when models are already somewhere: nothing is ever moved.
!include nsDialogs.nsh

; An installer with pages would first ask "Anyone who uses this computer" or "Only for me"; the first needs an admin.
; Yogurt is always installed just for this person (perMachine: false), so that page is skipped.
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

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
  ; the heading above the page (MUI2 isn't loaded yet where this file is included, so set directly)
  GetDlgItem $0 $HWNDPARENT 1037
  SendMessage $0 ${WM_SETTEXT} 0 "STR:Choose where the AI models go"
  GetDlgItem $0 $HWNDPARENT 1038
  SendMessage $0 ${WM_SETTEXT} 0 "STR:They're big, so pick a drive with space."
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
