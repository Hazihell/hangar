# Run elevated, once: HWiNFO needs admin rights to read the CPU's temperature, so
# a logon task starts it with them. After this, the Dashboard can start or stop it
# through the task without another UAC prompt.
param([string]$User = "$env:USERDOMAIN\$env:USERNAME")
$ErrorActionPreference = 'Stop'
$exe = Join-Path $env:ProgramFiles 'HWiNFO64\HWiNFO64.EXE'
if (-not (Test-Path $exe)) { throw "HWiNFO64 isn't installed at $exe" }

# Sensors only, straight to the tray, no welcome screen.
$ini = Join-Path (Split-Path $exe) 'HWiNFO64.INI'
$settings = [ordered]@{ SensorsOnly = 1; SummaryOnly = 0; OpenSensors = 1; OpenSystemSummary = 0; MinimalizeMainWnd = 1; MinimalizeSensors = 1; MinimalizeSensorsClose = 1; ShowWelcomeAndProgress = 0; AutoUpdate = 0 }
$lines = if (Test-Path $ini) { @(Get-Content $ini) } else { @('[Settings]') }
foreach ($key in $settings.Keys) {
  $line = "$key=$($settings[$key])"
  $at = [Array]::FindIndex([string[]]$lines, [Predicate[string]]{ param($l) $l -match "^\s*$key\s*=" })
  if ($at -ge 0) { $lines[$at] = $line } else { $lines += $line }
}
Set-Content -Path $ini -Value $lines -Encoding ASCII

# Gadget reporting: HWiNFO publishes the ticked readings under HKCU\Software\HWiNFO64\VSB
# (Sensor#, Label#, ValueRaw#), which a non-elevated reader can see. F0000501_0\Temp0 is
# the Ryzen's "CPU (Tctl/Tdie)"; the Dashboard finds it by label, not by index.
$sensors = 'HKCU:\Software\HWiNFO64\Sensors'
New-Item -Path "$sensors\F0000501_0\Temp0" -Force | Out-Null
Set-ItemProperty -Path $sensors -Name EnableVSB -Value 1 -Type DWord
Set-ItemProperty -Path "$sensors\F0000501_0\Temp0" -Name InVSB -Value 1 -Type DWord
Set-ItemProperty -Path "$sensors\F0000501_0\Temp0" -Name VSBidx -Value 0 -Type DWord

# HWiNFO asks for uiAccess, which CreateProcess refuses (ERROR_ELEVATION_REQUIRED);
# the shell's Start-Process starts it, without a prompt, from this elevated task.
$powershell = Join-Path $PSHOME 'powershell.exe'
$action = New-ScheduledTaskAction -Execute $powershell -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -Command Start-Process -FilePath '$exe'"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $User
$principal = New-ScheduledTaskPrincipal -UserId $User -LogonType Interactive -RunLevel Highest
$options = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -StartWhenAvailable
Register-ScheduledTask -TaskName 'Hangar HWiNFO' -Action $action -Trigger $trigger -Principal $principal -Settings $options -Force | Out-Null
Start-ScheduledTask -TaskName 'Hangar HWiNFO'
