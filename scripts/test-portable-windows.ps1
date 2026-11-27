$ErrorActionPreference = 'Stop'
$output = Join-Path ([IO.Path]::GetTempPath()) ('meeting-portable-test-' + [guid]::NewGuid().ToString('N') + '.exe')
try {
    $compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
    $source = Join-Path $PSScriptRoot 'PortableLauncher.cs'
    $tests = Join-Path $PSScriptRoot '../test/portable-launcher.test.cs'
    & $compiler /nologo /target:exe /main:PortableLauncherTests /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.IO.Compression.dll "/out:$output" $source $tests
    if ($LASTEXITCODE -ne 0) { throw 'Portable tests did not compile.' }
    $assembly = [Reflection.Assembly]::Load([IO.File]::ReadAllBytes($output))
    $assembly.EntryPoint.Invoke($null, @()) | Out-Null
} finally { Remove-Item $output -Force -ErrorAction SilentlyContinue }
