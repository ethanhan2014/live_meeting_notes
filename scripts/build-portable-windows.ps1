param(
    [Parameter(Mandatory = $true)][string]$PayloadDirectory,
    [Parameter(Mandatory = $true)][string]$Output,
    [switch]$IncludePrivateDefaults
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
$payload = (Resolve-Path $PayloadDirectory).Path
$outputPath = [IO.Path]::GetFullPath($Output)
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('meeting-portable-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $temporary | Out-Null
try {
    foreach ($name in @('live-meeting-notes.exe', 'runtime/node.exe', 'runtime/main.cjs', 'python/python.exe', 'python/python312._pth', 'ffmpeg/bin/avcodec-61.dll', 'models/wav2vec2_fairseq_base_ls960_asr_ls960.pth', 'torch/hub/trusted_list')) {
        if (!(Test-Path (Join-Path $payload $name))) { throw "Missing portable runtime file: $name" }
    }
    $archive = Join-Path $temporary 'payload.zip'
    $zip = [IO.Compression.ZipFile]::Open($archive, [IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($file in Get-ChildItem $payload -File -Recurse -Force) {
            $name = $file.FullName.Substring($payload.Length + 1).Replace('\', '/')
            if ($name -match '(^|/)(\.env(\..*)?|settings\.json|credentials[^/]*\.json|auth[^/]*\.json)$') {
                if (!$IncludePrivateDefaults -or $name -ne 'runtime/.env') { continue }
            }
            if ($name -match '(^|/)(__pycache__|\.locks)/') { continue }
            # WhisperX does not compile C++ extensions; omit PyTorch's developer files.
            if ($name -match '^python/Lib/site-packages/torch/(include/|lib/[^/]+\.lib$)') { continue }
            [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $file.FullName, $name, [IO.Compression.CompressionLevel]::Optimal) | Out-Null
        }
    } finally { $zip.Dispose() }
    $hash = (Get-FileHash $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    $source = Join-Path $temporary 'PortableLauncher.cs'
    $template = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'PortableLauncher.cs'))
    [IO.File]::WriteAllText($source, $template.Replace('__PAYLOAD_HASH__', $hash))
    New-Item -ItemType Directory ([IO.Path]::GetDirectoryName($outputPath)) -Force | Out-Null
    $compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
    $icon = Join-Path $PSScriptRoot '../src-tauri/icons/icon.ico'
    & $compiler /nologo /target:winexe /platform:x64 /optimize+ "/out:$outputPath" "/win32icon:$icon" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll "/resource:$archive,payload.zip" $source
    if ($LASTEXITCODE -ne 0) { throw 'Portable launcher compilation failed.' }
    $checksum = (Get-FileHash $outputPath -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText($outputPath + '.sha256', $checksum + '  ' + [IO.Path]::GetFileName($outputPath) + "`n")
    Write-Output "Built $outputPath"
} finally { Remove-Item $temporary -Recurse -Force }
