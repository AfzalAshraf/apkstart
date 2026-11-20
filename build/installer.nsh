; ApkStart custom NSIS script
; Stop any runtime processes that may still be running before uninstall begins,
; otherwise, they can lock installation files and prevent a clean uninstall.
;
; A detached QEMU process may remain after ApkStart exits for a faster next launch,
; so the uninstaller must stop it as a fallback.

; Create desktop shortcuts as a final installation fallback.
; electron-builder createDesktopShortcut uses its own CreateShortcuts flow.
; It may fail in some environments (for example, redirected desktops or security software undoing the shortcut),
; leaving the user without a desktop icon. Create it again using the native NSIS CreateShortcut command.
; $DESKTOP uses SHGetFolderPath and follows redirected desktop paths. This is idempotent,
; so it safely overwrites the same .lnk if electron-builder already created it.
!macro customInstall
  DetailPrint "Creating desktop shortcuts..."
  CreateShortcut "$DESKTOP\ApkStart.lnk" "$INSTDIR\ApkStart.exe" "" "$INSTDIR\ApkStart.exe" 0 \
    SW_SHOWNORMAL "" "ApkStart — Run Android apps directly on your PC"
  CreateDirectory "$SMPROGRAMS\ApkStart"
  CreateShortcut "$SMPROGRAMS\ApkStart\ApkStart.lnk" "$INSTDIR\ApkStart.exe" "" "$INSTDIR\ApkStart.exe" 0 \
    SW_SHOWNORMAL "" "ApkStart — Run Android apps directly on your PC"
!macroend

!macro customUnInstall
  ; Remove our shortcuts too, leaving no residue if ApkStart is already absent.
  Delete "$DESKTOP\ApkStart.lnk"
  Delete "$SMPROGRAMS\ApkStart\ApkStart.lnk"
  RMDir "$SMPROGRAMS\ApkStart"

  DetailPrint "Stopping leftover ApkStart processes..."
  ; /F forces termination and /T includes child processes. Ignore taskkill status 128 when a process is absent.
  nsExec::Exec 'taskkill.exe /F /T /IM ApkStart.exe'
  nsExec::Exec 'taskkill.exe /F /T /IM qemu-system-x86_64.exe'
  nsExec::Exec 'taskkill.exe /F /T /IM qemu-system-i386.exe'
  nsExec::Exec 'taskkill.exe /F /T /IM emulator.exe'
  nsExec::Exec 'taskkill.exe /F /T /IM emulator-check.exe'
  nsExec::Exec 'taskkill.exe /F /T /IM adb.exe'
  nsExec::Exec 'taskkill.exe /F /T /IM netsimd.exe'
  ; Allow processes time to exit and release file handles
  Sleep 1500
!macroend
