; 3D → 도트 스프라이트 변환기 — Windows 설치 프로그램 (NSIS 3, Unicode)
; 빌드: desktop/build-installer.sh   (makensis /DVERSION=x.y.z installer.nsi)
Unicode true
!ifndef VERSION
  !define VERSION "0.1.0"
!endif

!define APP_NAME     "3D 도트 스프라이트 변환기"
!define APP_ID       "Sprite3D2D"
!define APP_EXE      "sprite3d2d.exe"
!define UNINST_KEY   "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}"
; Microsoft Edge WebView2 런타임(Evergreen) 클라이언트 GUID
!define WV2_KEY      "Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
!define WV2_KEY_WOW  "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
!define WV2_URL      "https://go.microsoft.com/fwlink/p/?LinkId=2124703"

!include "MUI2.nsh"
!include "x64.nsh"
!include "FileFunc.nsh"

Name "${APP_NAME}"
OutFile "..\release\Sprite3D2D-Setup.exe"
; 관리자 권한 없이 사용자 폴더에 설치
RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\Programs\${APP_ID}"
InstallDirRegKey HKCU "Software\${APP_ID}" "InstallDir"
SetCompressor /SOLID lzma
BrandingText "${APP_NAME} ${VERSION}"

VIProductVersion "${VERSION}.0"
VIAddVersionKey /LANG=1042 "ProductName" "${APP_NAME}"
VIAddVersionKey /LANG=1042 "FileDescription" "${APP_NAME} 설치 프로그램"
VIAddVersionKey /LANG=1042 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=1042 "ProductVersion" "${VERSION}"
VIAddVersionKey /LANG=1042 "LegalCopyright" " "

!define MUI_ICON   "icon\icon_legacy.ico"
!define MUI_UNICON "icon\icon_legacy.ico"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP_EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "${APP_NAME} 실행"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "Korean"

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_OK|MB_ICONSTOP "이 프로그램은 64비트 Windows 에서만 실행됩니다."
    Abort
  ${EndIf}
FunctionEnd

; WebView2 런타임이 없으면 안내 (Windows 11 과 최신 Windows 10 에는 기본 설치되어 있다)
Function CheckWebView2
  ReadRegStr $0 HKLM "${WV2_KEY_WOW}" "pv"
  ${If} $0 == ""
    ReadRegStr $0 HKCU "${WV2_KEY}" "pv"
  ${EndIf}
  ${If} $0 == ""
  ${OrIf} $0 == "0.0.0.0"
    ${IfNot} ${Silent}
      MessageBox MB_YESNO|MB_ICONINFORMATION "Microsoft Edge WebView2 런타임이 설치되어 있지 않은 것 같습니다.$\n프로그램을 실행하려면 필요합니다.$\n$\n지금 다운로드 페이지를 열까요?" IDNO +2
      ExecShell "open" "${WV2_URL}"
    ${EndIf}
  ${EndIf}
FunctionEnd

Section "${APP_NAME} (필수)" SecMain
  SectionIn RO
  SetOutPath "$INSTDIR"
  SetOverwrite on
  File "..\release\windows-x64\${APP_EXE}"
  File "..\release\windows-x64\WebView2Loader.dll"
  File "icon\icon.ico"
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  CreateShortcut "$SMPROGRAMS\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\icon.ico"

  WriteRegStr HKCU "Software\${APP_ID}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\icon.ico"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "${UNINST_KEY}" "EstimatedSize" "$0"

  Call CheckWebView2
SectionEnd

Section "바탕화면 바로가기" SecDesktop
  CreateShortcut "$DESKTOP\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\icon.ico"
SectionEnd

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SecMain} "프로그램 파일과 시작 메뉴 바로가기를 설치합니다."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecDesktop} "바탕화면에 바로가기를 만듭니다."
!insertmacro MUI_FUNCTION_DESCRIPTION_END

Section "Uninstall"
  Delete "$INSTDIR\${APP_EXE}"
  Delete "$INSTDIR\WebView2Loader.dll"
  Delete "$INSTDIR\icon.ico"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  Delete "$SMPROGRAMS\${APP_NAME}.lnk"
  Delete "$DESKTOP\${APP_NAME}.lnk"
  DeleteRegKey HKCU "${UNINST_KEY}"
  DeleteRegKey HKCU "Software\${APP_ID}"

  ; 저장된 설정(WebView2 사용자 데이터)은 기본적으로 남겨 둔다
  ${IfNot} ${Silent}
    MessageBox MB_YESNO|MB_ICONQUESTION "저장된 설정과 캐시도 삭제할까요?$\n($LOCALAPPDATA\sprite3d2d)" IDNO +2
    RMDir /r "$LOCALAPPDATA\sprite3d2d"
  ${EndIf}
SectionEnd
