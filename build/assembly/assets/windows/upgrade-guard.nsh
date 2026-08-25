!macro verifyPreviousInstallRemoved
  ${if} ${Errors}
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(uninstallFailed)" /SD IDOK
    SetErrorLevel 2
    Quit
  ${endif}

  ${if} $R0 != 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(uninstallFailed): $R0" /SD IDOK
    SetErrorLevel 2
    Quit
  ${endif}

  # customUnInstallCheck is expanded before electron-builder declares its
  # installationDir variable. Resolve the old directory again from the same
  # registry root instead of relying on that later declaration.
  StrCpy $R1 ""
  !insertmacro readReg $R1 "$rootKey_uninstallResult" "${INSTALL_REGISTRY_KEY}" InstallLocation

  ${if} $R1 == ""
    StrCpy $R2 ""
    !insertmacro readReg $R2 "$rootKey_uninstallResult" "${UNINSTALL_REGISTRY_KEY}" UninstallString
    ${if} $R2 == ""
      !ifdef UNINSTALL_REGISTRY_KEY_2
        !insertmacro readReg $R2 "$rootKey_uninstallResult" "${UNINSTALL_REGISTRY_KEY_2}" UninstallString
      !endif
    ${endif}

    ${if} $R2 != ""
      !insertmacro GetInQuotes $R3 "$R2"
      ${if} $R3 != ""
        Push $R3
        Call GetFileParent
        Pop $R1
      ${endif}
    ${endif}
  ${endif}

  ${if} $R1 != ""
    ${if} ${FileExists} "$R1\*.*"
      MessageBox MB_OK|MB_ICONEXCLAMATION "$(appCannotBeClosed)$\r$\n$R1" /SD IDOK
      SetErrorLevel 2
      Quit
    ${endif}
  ${endif}
!macroend

# electron-builder 只相信旧卸载器的退出码。旧版本可能在文件被占用时错误返回 0，
# 因此新版安装器还必须检查实际目录，避免继续解压出半新半旧的安装状态。
!macro customUnInstallCheck
  !insertmacro verifyPreviousInstallRemoved
!macroend

!macro customUnInstallCheckCurrentUser
  !insertmacro verifyPreviousInstallRemoved
!macroend

# 让本版本生成的卸载器在未来升级遇到占用文件时返回非零状态。electron-builder
# 随后会按既有逻辑重试并提示用户关闭应用，而不是把失败当成成功。
!macro customRemoveFiles
  ${if} ${isUpdated}
    CreateDirectory "$PLUGINSDIR\old-install"

    Push ""
    Call un.atomicRMDir
    Pop $R0

    ${if} $R0 != 0
      DetailPrint "File is busy, aborting: $R0"
      Push ""
      Call un.restoreFiles
      Pop $R0
      SetErrorLevel 2
      Quit
    ${endif}
  ${endif}

  SetOutPath $TEMP
  RMDir /r "$INSTDIR"

  ${if} ${isUpdated}
    ${if} ${FileExists} "$INSTDIR\*.*"
      DetailPrint "Installation directory still contains files: $INSTDIR"
      SetErrorLevel 2
      Quit
    ${endif}
  ${endif}
!macroend
