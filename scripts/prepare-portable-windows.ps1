param(
    [Parameter(Mandatory = $true)][string]$AppDirectory,
    [Parameter(Mandatory = $true)][string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$app = (Resolve-Path $AppDirectory).Path
$destination = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path $destination) { throw 'Use an empty output directory for the portable runtime.' }
New-Item -ItemType Directory $destination | Out-Null
$downloads = Join-Path ([IO.Path]::GetTempPath()) ('meeting-runtime-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $downloads | Out-Null
function Download([string]$Url, [string]$Name, [string]$Hash) {
    $file = Join-Path $downloads $Name
    Invoke-WebRequest -Uri $Url -OutFile $file -UseBasicParsing
    if ((Get-FileHash $file -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Hash) { throw "Download checksum failed: $Name" }
    return $file
}
try {
    Copy-Item (Join-Path $app 'live-meeting-notes.exe') $destination
    Copy-Item (Join-Path $app 'runtime') $destination -Recurse
    if (Test-Path (Join-Path $app 'WebView2Loader.dll')) { Copy-Item (Join-Path $app 'WebView2Loader.dll') $destination }
    $manifest = Join-Path $destination 'runtime/manifest.json'
    $metadata = Get-Content $manifest -Raw | ConvertFrom-Json
    $metadata.pythonBundled = $true
    $metadata | ConvertTo-Json | Set-Content $manifest
    $pythonZip = Download 'https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip' 'python.zip' '4acbed6dd1c744b0376e3b1cf57ce906f9dc9e95e68824584c8099a63025a3c3'
    $pythonDirectory = Join-Path $destination 'python'
    [IO.Compression.ZipFile]::ExtractToDirectory($pythonZip, $pythonDirectory)
    [IO.File]::WriteAllLines((Join-Path $pythonDirectory 'python312._pth'), @('python312.zip', '.', 'Lib/site-packages', 'import site'), [Text.Encoding]::ASCII)
    $bootstrap = Download 'https://bootstrap.pypa.io/get-pip.py' 'get-pip.py' '356e0d0de21cdc348c3394084d90939b85e4246c4d14c76aee6ca4f46646ea98'
    $python = Join-Path $pythonDirectory 'python.exe'
    & $python $bootstrap --no-warn-script-location
    if ($LASTEXITCODE -ne 0) { throw 'Could not prepare bundled pip.' }
    & $python -m pip install --no-warn-script-location -r (Join-Path $PSScriptRoot '../python/requirements.txt')
    if ($LASTEXITCODE -ne 0) { throw 'Could not install the CPU WhisperX runtime.' }
    $ffmpegZip = Download 'https://github.com/FFmpeg-Builds/FFmpeg-Builds/releases/download/autobuild-2026-07-31-14-10/ffmpeg-n7.1.5-12-g1fdbca85aa-win64-lgpl-shared-7.1.zip' 'ffmpeg.zip' '0f376f96fb38554ccefb1b2ae9c7c6a7b351f0e60a372b38262c320e8392c5d0'
    $ffmpegUnpacked = Join-Path $downloads 'ffmpeg'
    [IO.Compression.ZipFile]::ExtractToDirectory($ffmpegZip, $ffmpegUnpacked)
    Move-Item (Get-ChildItem $ffmpegUnpacked -Directory | Select-Object -First 1).FullName (Join-Path $destination 'ffmpeg')
    $webviewCab = Download 'https://msedge.sf.dl.delivery.mp.microsoft.com/filestreamingservice/files/4fe269a2-de5a-488b-b6a0-9d9a42d641b8/Microsoft.WebView2.FixedVersionRuntime.158.0.4370.45.x64.cab' 'webview2.cab' 'a7d41bc8b51f5594130113c8e218742a2762fbc74c4ee4c2a4e59b9ec172aff5'
    $webviewUnpacked = Join-Path $downloads 'webview2'
    New-Item -ItemType Directory $webviewUnpacked | Out-Null
    & (Join-Path $env:WINDIR 'System32/expand.exe') '-F:*' $webviewCab $webviewUnpacked | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not extract the fixed WebView2 runtime.' }
    Move-Item (Get-ChildItem $webviewUnpacked -Directory | Select-Object -First 1).FullName (Join-Path $destination 'webview2')
    Copy-Item (Join-Path $destination 'webview2/msvcp140*.dll') $pythonDirectory
    $customize = @'
import os
from pathlib import Path
if os.name == 'nt':
    _ffmpeg_dlls = os.add_dll_directory(str(Path(__file__).resolve().parent.parent / 'ffmpeg' / 'bin'))
'@
    [IO.File]::WriteAllText((Join-Path $pythonDirectory 'sitecustomize.py'), $customize)
    $env:MEETING_PYTHON = $python
    $env:MEETING_MODEL_CACHE = Join-Path $destination 'models'
    $env:TORCH_HOME = Join-Path $destination 'torch'
    $env:PATH = (Join-Path $destination 'ffmpeg/bin') + ';' + $env:PATH
    & $python -m pip freeze --all | Set-Content (Join-Path $pythonDirectory 'requirements.lock')
    $sample = Join-Path $downloads 'jfk-full.wav'
    Invoke-WebRequest 'https://raw.githubusercontent.com/ggml-org/whisper.cpp/master/samples/jfk.wav' -OutFile $sample -UseBasicParsing
    $short = Join-Path $downloads 'jfk.wav'
    & $python (Join-Path $PSScriptRoot 'verify-portable-runtime.py') $sample $short
    if ($LASTEXITCODE -ne 0) { throw 'Bundled CPU runtime verification failed.' }
    & (Join-Path $destination 'runtime/node.exe') (Join-Path $PSScriptRoot 'native-smoke.cjs') $short
    if ($LASTEXITCODE -ne 0) { throw 'Bundled CPU speech verification failed.' }
    Write-Output "Prepared portable runtime: $destination"
} finally { Remove-Item $downloads -Recurse -Force }
