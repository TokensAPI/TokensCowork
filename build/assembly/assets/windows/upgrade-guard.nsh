# 递归检测 $R9\<相对路径> 下是否仍有真实文件；空目录不算残留。
# 卸载后根目录可能因外部句柄（杀软、父进程）暂时删不掉而留下空壳，
# NSIS 的 IfFileExists "目录\*.*" 对空目录也为真，不能用作失败依据。
# 用法：StrCpy $R9 "<根目录>" ; Push "" ; Call [un.]hasSurvivingFiles ; Pop $R0 → 1/0
!macro defineHasSurvivingFiles UN
Function ${UN}hasSurvivingFiles
  Exch $R0
  Push $R1
  Push $R2
  Push $R3

  StrCpy $R3 0
  FindFirst $R1 $R2 "$R9$R0\*.*"

  loop:
    StrCmp $R2 "" done
    StrCmp $R2 "." next
    StrCmp $R2 ".." next

    IfFileExists "$R9$R0\$R2\*.*" isDir isFile

    isDir:
      Push "$R0\$R2"
      Call ${UN}hasSurvivingFiles
      Pop $R3
      StrCmp $R3 1 done next

    isFile:
      StrCpy $R3 1
      Goto done

    next:
      FindNext $R1 $R2
      Goto loop

  done:
    FindClose $R1
    StrCpy $R0 $R3
    Pop $R3
    Pop $R2
    Pop $R1
    Exch $R0
FunctionEnd
!macroend

!insertmacro defineHasSurvivingFiles ""
!insertmacro defineHasSurvivingFiles "un."

!macro verifyPreviousInstallRemoved
  ${if} ${Errors}
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(uninstallFailed)" /SD IDOK
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

  ${if} $R1 == ""
    # 旧卸载器失败且无法定位旧目录时无从核实清理结果，安全终止；
    # 定位不到又返回成功说明本就没有旧安装，正常继续。
    ${if} $R0 != 0
      MessageBox MB_OK|MB_ICONEXCLAMATION "$(uninstallFailed): $R0" /SD IDOK
      SetErrorLevel 2
      Quit
    ${endif}
  ${else}
    # 不再只信旧卸载器的退出码：0.3.9 的卸载器会把"根目录空壳删不掉"
    # 误报为失败（且此时应用文件已被其临时目录清理带走）。以旧目录中
    # 是否残留真实文件为准——有文件才是真失败（例如仍被占用），只剩
    # 空壳则视为卸载完成，继续安装并重写同一注册表项。
    Push $R9
    StrCpy $R9 $R1
    Push ""
    Call hasSurvivingFiles
    Pop $R2
    Pop $R9

    ${if} $R2 == 1
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
      # 根目录可能因外部句柄暂时删不掉而留下空壳；空壳不影响新版本
      # 覆盖安装，只有真实文件残留才算失败。真失败时先把应用恢复原状
      # 再退出，否则已搬进临时目录的文件会随本进程清理被删除。
      Push $R9
      StrCpy $R9 $INSTDIR
      Push ""
      Call un.hasSurvivingFiles
      Pop $R0
      Pop $R9

      ${if} $R0 == 1
        DetailPrint "Installation directory still contains files: $INSTDIR"
        Push ""
        Call un.restoreFiles
        Pop $R0
        SetErrorLevel 2
        Quit
      ${endif}
    ${endif}
  ${endif}
!macroend
