param([Parameter(Mandatory=$true)][string]$Name)
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$ErrorActionPreference = 'Stop'
try {
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode, Pack = 4)]
public struct RASDIALPARAMS {
  public int dwSize;
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 257)] public string szEntryName;
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 129)] public string szPhoneNumber;
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 129)] public string szCallbackNumber;
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 257)] public string szUserName;
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 257)] public string szPassword;
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 16)] public string szDomain;
  public int dwSubEntry; public IntPtr dwCallbackId; public int dwIfIndex; public IntPtr szEncPassword;
}
public static class Ras {
  [DllImport("rasapi32.dll")] public static extern int RasHangUp(IntPtr conn);
  [DllImport("rasapi32.dll", CharSet = CharSet.Unicode)] public static extern int RasGetEntryDialParams(string pbk, ref RASDIALPARAMS p, out bool hasPassword);
  [DllImport("rasapi32.dll", CharSet = CharSet.Unicode)] public static extern int RasDial(IntPtr ext, string pbk, ref RASDIALPARAMS p, int notifierType, IntPtr notifier, out IntPtr conn);
  [DllImport("rasapi32.dll", CharSet = CharSet.Unicode)] public static extern int RasGetErrorString(int code, System.Text.StringBuilder buf, int size);
}
'@
$rc = 623
foreach ($base in @($env:APPDATA, $env:ProgramData)) {
  $pbk = Join-Path $base 'Microsoft\Network\Connections\Pbk\rasphone.pbk'
  $p = New-Object RASDIALPARAMS
  $p.dwSize = [Runtime.InteropServices.Marshal]::SizeOf([type][RASDIALPARAMS])
  $p.szEntryName = $Name
  $hasPassword = $false
  $rc = [Ras]::RasGetEntryDialParams($pbk, [ref]$p, [ref]$hasPassword)
  if ($rc -notin @(621, 623)) { break }
}
if ($rc -in @(621, 623)) { $rc = 623 }
if ($rc -eq 0) {
  if (-not $hasPassword -and [string]::IsNullOrEmpty($p.szUserName)) { throw 'No saved password for this VPN' }
  $connection = [IntPtr]::Zero
  $rc = [Ras]::RasDial([IntPtr]::Zero, $pbk, [ref]$p, 0, [IntPtr]::Zero, [ref]$connection)
  if ($rc -ne 0 -and $connection -ne [IntPtr]::Zero) { $null = [Ras]::RasHangUp($connection) }
}
if ($rc -ne 0) {
  $message = New-Object System.Text.StringBuilder 512
  if ([Ras]::RasGetErrorString($rc, $message, 512) -ne 0) { throw "VPN error $rc" }
  throw $message.ToString()
}
exit 0
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
