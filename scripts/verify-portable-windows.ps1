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
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9238'
    $guiStart = New-Object Diagnostics.ProcessStartInfo
    $guiStart.FileName = $executablePath
    $guiStart.UseShellExecute = $false
    $guiStart.RedirectStandardOutput = $true
    $guiStart.RedirectStandardError = $true
    $guiStart.EnvironmentVariables['WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS'] = $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
    $guiStart.EnvironmentVariables['MEETING_DATA_DIR'] = $env:MEETING_DATA_DIR
    $launcher = [Diagnostics.Process]::Start($guiStart)
    $guiErrors = $launcher.StandardError.ReadToEndAsync()
    try {
        $kind = if ($AllowPrivateDefaults) { 'private' } else { 'public' }
        & (Join-Path $directory 'runtime/node.exe') (Join-Path $PSScriptRoot 'verify-portable-ui.cjs') $kind
        if ($LASTEXITCODE -ne 0) { throw 'Packaged GUI startup failed.' }
    } catch {
        Write-Output ('Launcher exited: ' + $launcher.HasExited)
        foreach ($child in Get-CimInstance Win32_Process -Filter ("ParentProcessId = " + $launcher.Id)) {
            Get-Process -Id $child.ProcessId -ErrorAction SilentlyContinue | Select-Object ProcessName,MainWindowTitle,MainWindowHandle
        }
        throw
    } finally {
        foreach ($child in Get-CimInstance Win32_Process -Filter ("ParentProcessId = " + $launcher.Id)) {
            $process = Get-Process -Id $child.ProcessId -ErrorAction SilentlyContinue
            if ($process) { [void]$process.CloseMainWindow(); if (!$process.WaitForExit(15000)) { $process.Kill() } }
        }
        if (!$launcher.WaitForExit(15000)) { $launcher.Kill() }
        if ($guiErrors.IsCompleted -and $guiErrors.Result) { Write-Output $guiErrors.Result }
        Remove-Item Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS -ErrorAction SilentlyContinue
    }
    Write-Output ('Portable extraction and offline speech passed: ' + $directory)
} finally { Remove-Item $temporary -Recurse -Force }
