@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo   엑셀 - PPT 품목 카탈로그 생성기 빌드
echo ============================================
echo.
echo [준비] 패키지 설치 중...
python -m pip install --upgrade pip >nul 2>&1
python -m pip install --upgrade pyinstaller openpyxl python-pptx pillow
echo.
echo [공유] 바탕화면에 excel_to_ppt.py 복사
copy /Y "excel_to_ppt.py" "%USERPROFILE%\Desktop\excel_to_ppt.py" >nul
echo.
echo [1/2] exe 빌드 중... (수 분 소요)
python -m PyInstaller --onefile --noconsole --name OrbitPPT --clean excel_to_ppt.py

if exist "dist\OrbitPPT.exe" (
  copy /Y "dist\OrbitPPT.exe" "%USERPROFILE%\Desktop\엑셀PPT생성기.exe" >nul
  echo.
  echo [완료] 바탕화면에  "엑셀PPT생성기.exe"  생성 완료!  (콘솔창 없음)
  goto end
)

echo.
echo [경고] exe 빌드 실패 - 콘솔 없는 바로가기(.vbs)로 대체합니다.
set "PYW="
for /f "delims=" %%i in ('where pythonw 2^>nul') do set "PYW=%%i"
if not defined PYW for /f "delims=" %%i in ('where python') do set "PYW=%%i"
set "VBS=%USERPROFILE%\Desktop\엑셀PPT생성기.vbs"
> "%VBS%" echo CreateObject("WScript.Shell").Run """%PYW%"" ""%~dp0excel_to_ppt.py""", 0, False
echo [완료] 바탕화면에  "엑셀PPT생성기.vbs"  생성 (더블클릭 실행, 콘솔 없음).

:end
echo.
pause
