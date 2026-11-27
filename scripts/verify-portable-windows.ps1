param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [switch]$AllowPrivateDefaults
)
$ErrorActionPreference = 'Stop'
$executablePath = (Resolve-Path $Executable).Path
$start = New-Object Diagnostics.ProcessStartInfo
$start.FileName = $executablePath
$start.Arguments = '--verify-portable'
$start.UseShellExecute = $false
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$app = [Diagnostics.Process]::Start($start)
$output = $app.StandardOutput.ReadToEndAsync()
$errors = $app.StandardError.ReadToEndAsync()
if (!$app.WaitForExit(600000)) { $app.Kill(); throw 'Portable extraction timed out.' }
if ($app.ExitCode -ne 0) { throw ('Portable extraction failed: ' + $errors.Result) }
$directory = $output.Result.Trim()
if (!$directory -or !(Test-Path (Join-Path $directory '.complete'))) { throw 'Portable cache marker is missing.' }
if (!$AllowPrivateDefaults -and (Test-Path (Join-Path $directory 'runtime/.env'))) { throw 'Public portable contains private API defaults.' }
$env:MEETING_PYTHON = Join-Path $directory 'python/python.exe'
$env:MEETING_MODEL_CACHE = Join-Path $directory 'models'
$env:TORCH_HOME = Join-Path $directory 'torch'
$env:HF_HUB_OFFLINE = '1'
$env:PATH = (Join-Path $directory 'ffmpeg/bin') + ';' + $env:PATH
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('meeting-portable-verify-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $temporary | Out-Null
$env:MEETING_DATA_DIR = Join-Path $temporary 'profile'
try {
    Invoke-WebRequest https://raw.githubusercontent.com/ggml-org/whisper.cpp/master/samples/jfk.wav -OutFile (Join-Path $temporary 'jfk-full.wav') -UseBasicParsing
    $sample = Join-Path $temporary 'jfk.wav'
    & $env:MEETING_PYTHON (Join-Path $PSScriptRoot 'verify-portable-runtime.py') (Join-Path $temporary 'jfk-full.wav') $sample
    if ($LASTEXITCODE -ne 0) { throw 'Packaged Python runtime failed.' }
    & (Join-Path $directory 'runtime/node.exe') (Join-Path $PSScriptRoot 'native-smoke.cjs') $sample
    if ($LASTEXITCODE -ne 0) { throw 'Packaged offline CPU speech failed.' }
    Write-Output ('Portable extraction and offline speech passed: ' + $directory)
} finally { Remove-Item $temporary -Recurse -Force }
