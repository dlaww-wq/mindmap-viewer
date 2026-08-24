# ocr-extract.ps1 — Windows 내장 OCR(Windows.Media.Ocr)로 이미지 텍스트 추출.
# 설치 불필요·$0·quota無. 한글은 사용자 언어에 한국어 OCR 팩이 있으면 인식.
# 사용: powershell -NoProfile -ExecutionPolicy Bypass -File ocr-extract.ps1 -Path C:\img.png
# 출력: 인식된 텍스트(실패/불가 시 빈 문자열, exit 0 — 호출측이 '불가'로 처리해 Vision으로 승격).
param([Parameter(Mandatory=$true)][string]$Path)
$ErrorActionPreference = 'Stop'
# 파이프 리다이렉트 시 한글이 깨지지 않도록 stdout을 UTF-8로 고정(호출측 node는 utf8로 디코드).
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$OutputEncoding = [System.Text.Encoding]::UTF8
try {
  if (-not (Test-Path $Path)) { Write-Output ''; exit 0 }
  Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
  $null = [Windows.Media.Ocr.OcrEngine,           Windows.Foundation, ContentType=WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType=WindowsRuntime]
  $null = [Windows.Storage.StorageFile,            Windows.Foundation, ContentType=WindowsRuntime]

  # WinRT IAsyncOperation<T> → .NET Task 대기 헬퍼
  $asTaskDef = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  } | Select-Object -First 1
  function Await($op, $t) {
    $m = $asTaskDef.MakeGenericMethod($t)
    $task = $m.Invoke($null, @($op))
    $task.Wait(-1) | Out-Null
    $task.Result
  }

  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if (-not $engine) { Write-Output ''; exit 0 }   # OCR 언어팩 없음 → 불가

  $file    = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Path)) ([Windows.Storage.StorageFile])
  $stream  = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read))    ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bmp     = Await ($decoder.GetSoftwareBitmapAsync())                          ([Windows.Graphics.Imaging.SoftwareBitmap])
  $result  = Await ($engine.RecognizeAsync($bmp))                              ([Windows.Media.Ocr.OcrResult])

  if ($result -and $result.Text) { Write-Output $result.Text } else { Write-Output '' }
} catch {
  # 어떤 오류든 '불가'로 처리(빈 출력) → 호출측이 Vision으로 안전 승격
  Write-Output ''
  exit 0
}
