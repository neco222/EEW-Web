param(
  [Parameter(Mandatory=$true)][int]$BrowserRootPid,
  [Parameter(Mandatory=$true)][string]$ProfileDirectory,
  [Parameter(Mandatory=$true)][string]$RequestPath,
  [Parameter(Mandatory=$true)][string]$StopPath
)
$ErrorActionPreference = 'Stop'
$root = Get-CimInstance Win32_Process -Filter "ProcessId = $BrowserRootPid"
if (-not $root -or -not $root.CommandLine.Contains($ProfileDirectory)) {
  throw 'The dedicated Chrome root did not match the exact benchmark profile.'
}
$tracked = @{}
$lastRequest = ''
$nextSample = [DateTime]::UtcNow
$logicalProcessors = [Environment]::ProcessorCount
function Sample-BrowserTree([string]$RequestToken) {
  $all = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate,CommandLine)
  $tree = [System.Collections.Generic.HashSet[int]]::new()
  [void]$tree.Add($BrowserRootPid)
  do {
    $changed = $false
    foreach ($entry in $all) {
      if ($tree.Contains([int]$entry.ParentProcessId) -and $tree.Add([int]$entry.ProcessId)) { $changed = $true }
    }
  } while ($changed)
  foreach ($entry in $all) {
    if (-not $tree.Contains([int]$entry.ProcessId)) { continue }
    $key = "$( [int]$entry.ProcessId ):$($entry.CreationDate.ToUniversalTime().Ticks)"
    if (-not $tracked.ContainsKey($key)) {
      $kind = if ($entry.CommandLine -match '--type=([^ ]+)') { $Matches[1] } else { 'browser' }
      $tracked[$key] = @{pid=[int]$entry.ProcessId;parentPid=[int]$entry.ParentProcessId;kind=$kind;createdAt=$entry.CreationDate.ToUniversalTime().ToString('o');cpuSeconds=0.0;lastSeenAt=$null}
    }
    try {
      $process = Get-Process -Id ([int]$entry.ProcessId) -ErrorAction Stop
      $tracked[$key].cpuSeconds = [Math]::Max($tracked[$key].cpuSeconds, $process.TotalProcessorTime.TotalSeconds)
      $tracked[$key].lastSeenAt = [DateTime]::UtcNow.ToString('o')
    } catch { }
  }
  $total = 0.0
  foreach ($entry in $tracked.Values) { $total += $entry.cpuSeconds }
  $snapshot = @{at=[DateTime]::UtcNow.ToString('o');request=$RequestToken;rootPid=$BrowserRootPid;logicalProcessors=$logicalProcessors;totalCpuSeconds=$total;processes=@($tracked.Values)}
  [Console]::Out.WriteLine(($snapshot | ConvertTo-Json -Depth 5 -Compress))
  [Console]::Out.Flush()
}
while (-not (Test-Path -LiteralPath $StopPath)) {
  $request = ''
  if (Test-Path -LiteralPath $RequestPath) {
    try { $request = (Get-Content -LiteralPath $RequestPath -Raw).Trim() } catch { }
  }
  if ($request -and $request -ne $lastRequest) {
    $lastRequest = $request
    Sample-BrowserTree $request
    $nextSample = [DateTime]::UtcNow.AddSeconds(1)
  } elseif ([DateTime]::UtcNow -ge $nextSample) {
    Sample-BrowserTree ''
    $nextSample = [DateTime]::UtcNow.AddSeconds(1)
  }
  Start-Sleep -Milliseconds 100
}
Sample-BrowserTree 'stopped'
