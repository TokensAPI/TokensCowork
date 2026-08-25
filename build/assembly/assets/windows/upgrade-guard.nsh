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

  ${if} $installationDir != ""
    ${if} ${FileExists} "$installationDir\*.*"
      MessageBox MB_OK|MB_ICONEXCLAMATION "$(appCannotBeClosed)$\r$\n$installationDir" /SD IDOK
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
