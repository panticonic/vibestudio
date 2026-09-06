!include "FileFunc.nsh"

; Use the pinned MXC host-preparation tool, never an application-owned ACL
; implementation. ShellExecute's runas verb obtains explicit Windows consent;
; the app and its workspace processes continue to run with the normal token.
!macro RunMxcPreparation arguments
  ${StdUtils.ExecShellWaitEx} $R0 $R1 "$INSTDIR\resources\app.asar.unpacked\dist\mxc\win32-x64\wxc-host-prep.exe" "runas" '${arguments}'
  ${If} $R0 != "ok"
    MessageBox MB_OK|MB_ICONSTOP "Windows sandbox setup could not start (status $R0, error $R1). Administrator approval is required."
    Abort "Windows sandbox prerequisites were not installed."
  ${EndIf}
  ${StdUtils.WaitForProcEx} $R0 $R1
  ${If} $R0 != "0"
    MessageBox MB_OK|MB_ICONSTOP "Windows sandbox setup failed (exit $R0). Run the installed wxc-host-prep.exe with administrator approval to diagnose the Windows policy."
    Abort "Windows sandbox prerequisites failed."
  ${EndIf}
!macroend

!macro customInstall
  MessageBox MB_OKCANCEL|MB_ICONINFORMATION "Vibestudio needs Windows sandbox preparation. Windows will request administrator approval. This grants sandboxed tools metadata access to the system and installation drive roots (not file contents or directory listings), and access to the NUL device. These are shared Windows prerequisites; the app itself runs without administrator rights." /SD IDOK IDOK +2
  Abort "Windows sandbox setup was cancelled."
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  ${GetRoot} "$WINDIR" $R2
  ${GetRoot} "$INSTDIR" $R3
  !insertmacro RunMxcPreparation 'prepare-system-drive --target $R2\'
  ${If} $R3 != $R2
    !insertmacro RunMxcPreparation 'prepare-system-drive --target $R3\'
  ${EndIf}
  !insertmacro RunMxcPreparation 'prepare-null-device'
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
!macroend

; Never undo shared OS preparation on uninstall: another MXC application may
; depend on it. MXC ships explicit unprepare-system-drive for administrator use.
