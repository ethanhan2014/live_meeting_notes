param([Parameter(Mandatory = $true)][int]$LauncherProcessId)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$deadline = (Get-Date).AddSeconds(45)
$names = @()
while ((Get-Date) -lt $deadline) {
    $child = Get-CimInstance Win32_Process -Filter ("ParentProcessId = " + $LauncherProcessId) | Where-Object Name -eq 'live-meeting-notes.exe' | Select-Object -First 1
    if ($child) {
        $app = Get-Process -Id $child.ProcessId -ErrorAction SilentlyContinue
        if ($app -and $app.MainWindowHandle -ne [IntPtr]::Zero) {
            $root = [System.Windows.Automation.AutomationElement]::FromHandle($app.MainWindowHandle)
            $elements = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
            $names = @($elements | ForEach-Object { $_.Current.Name } | Where-Object { $_ })
            if (($names -contains 'Saved locally') -and ($names -contains 'Ready · WhisperX loads on Start')) {
                Write-Output 'Portable GUI rendered live backend state through the Tauri bridge.'
                exit 0
            }
        }
    }
    Start-Sleep -Milliseconds 300
}
Write-Output ('[portable-check] Rendered labels: ' + ($names | Select-Object -Unique | ConvertTo-Json -Compress))
throw 'The portable interface did not render its backend state.'
