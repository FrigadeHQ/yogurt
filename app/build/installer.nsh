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
