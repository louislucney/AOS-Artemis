param(
  [string]$CenterHost = "192.168.3.91",
  [int]$ControlPort = 8765,
  [int]$HotfixPort = 8899,
  [string]$Root = "C:\RUNNER\mobile-testing-runner-0.1.0-win32-x64",
  [string]$Serial = "10CF6609P900059",
  [string]$AppPackage = "com.exxonmobil.mobil.gusp.uat",
  [int]$ExpectedVersionCode = 104010001,
  [switch]$Json
)

$ErrorActionPreference = "Stop"
$results = New-Object System.Collections.Generic.List[object]

function Add-Result {
  param([string]$Check, [string]$Status, [string]$Detail)
  $results.Add([pscustomobject]@{ Check = $Check; Status = $Status; Detail = $Detail })
}

function Test-TcpPort {
  param([string]$HostName, [int]$Port)
  try {
    return [bool](Test-NetConnection -ComputerName $HostName -Port $Port -InformationLevel Quiet -WarningAction SilentlyContinue)
  } catch {
    return $false
  }
}

function Get-AdbPath {
  $candidate = Join-Path $Root "tools\platform-tools\adb.exe"
  if (Test-Path $candidate) { return $candidate }
  $fromPath = Get-Command adb -ErrorAction SilentlyContinue
  if ($null -ne $fromPath) { return $fromPath.Source }
  return $null
}

function Invoke-Adb {
  param([string]$Adb, [string[]]$Arguments)
  try {
    $output = & $Adb @Arguments 2>&1
    return [pscustomobject]@{
      Code = $LASTEXITCODE
      Text = (($output | Out-String).Trim())
    }
  } catch {
    return [pscustomobject]@{ Code = 1; Text = $_.Exception.Message }
  }
}

$adb = Get-AdbPath

if (Test-TcpPort -HostName $CenterHost -Port $ControlPort) {
  Add-Result "center:$ControlPort" "PASS" "$CenterHost`:$ControlPort reachable"
} else {
  Add-Result "center:$ControlPort" "FAIL" "$CenterHost`:$ControlPort unreachable"
}

if (Test-TcpPort -HostName $CenterHost -Port $HotfixPort) {
  Add-Result "hotfix:$HotfixPort" "PASS" "$CenterHost`:$HotfixPort reachable"
} else {
  Add-Result "hotfix:$HotfixPort" "WARN" "$CenterHost`:$HotfixPort unreachable (hotfix download unavailable)"
}

if ($null -eq $adb) {
  Add-Result "adb" "FAIL" "adb not found under $Root or PATH"
} else {
  Add-Result "adb" "PASS" $adb
}

$deviceOnline = $false
if ($null -ne $adb) {
  $devices = Invoke-Adb $adb @("devices", "-l")
  $line = ($devices.Text -split "\r?\n" | Where-Object { $_ -match [regex]::Escape($Serial) } | Select-Object -First 1)
  if ($line -and $line -match "\sdevice\s") {
    $deviceOnline = $true
    Add-Result "device" "PASS" $line.Trim()
  } elseif ($line) {
    Add-Result "device" "FAIL" "device not ready: $($line.Trim())"
  } else {
    Add-Result "device" "FAIL" "serial $Serial not found in adb devices"
  }
}

if ($deviceOnline) {
  foreach ($package in @("dev.mobile.maestro", "dev.mobile.maestro.test")) {
    $path = Invoke-Adb $adb @("-s", $Serial, "shell", "pm", "path", $package)
    if ($path.Code -eq 0 -and $path.Text -match "^package:") {
      Add-Result "driver:$package" "PASS" $path.Text
    } else {
      Add-Result "driver:$package" "FAIL" "missing or not visible: $($path.Text)"
    }
  }

  $power = Invoke-Adb $adb @("-s", $Serial, "shell", "dumpsys", "power")
  if ($power.Text -match "mWakefulness=Awake" -or $power.Text -match "Display Power: state=ON") {
    Add-Result "screen" "PASS" "awake"
  } else {
    Add-Result "screen" "WARN" "wakefulness not detected; check manually"
  }

  $window = Invoke-Adb $adb @("-s", $Serial, "shell", "dumpsys", "window")
  if ($window.Text -match "mDreamingLockscreen=true" -or $window.Text -match "mShowingLockscreen=true" -or $window.Text -match "isStatusBarKeyguard=true") {
    Add-Result "keyguard" "FAIL" "device appears locked"
  } else {
    Add-Result "keyguard" "PASS" "no locked keyguard detected"
  }

  $appPath = Invoke-Adb $adb @("-s", $Serial, "shell", "pm", "path", $AppPackage)
  if ($appPath.Code -eq 0 -and $appPath.Text -match "^package:") {
    Add-Result "app" "PASS" $appPath.Text
    $dump = Invoke-Adb $adb @("-s", $Serial, "shell", "dumpsys", "package", $AppPackage)
    if ($dump.Text -match "versionCode=(\d+)") {
      $actual = [int]$matches[1]
      if ($actual -eq $ExpectedVersionCode) {
        Add-Result "app-version" "PASS" "versionCode=$actual"
      } else {
        Add-Result "app-version" "WARN" "versionCode=$actual (expected $ExpectedVersionCode)"
      }
    } else {
      Add-Result "app-version" "WARN" "versionCode not parsed"
    }
  } else {
    Add-Result "app" "FAIL" "app not installed: $($appPath.Text)"
  }

  $model = Invoke-Adb $adb @("-s", $Serial, "shell", "getprop", "ro.product.model")
  $release = Invoke-Adb $adb @("-s", $Serial, "shell", "getprop", "ro.build.version.release")
  Add-Result "device-info" "PASS" "$($model.Text) / Android $($release.Text)"
}

$maestro = Join-Path $Root "tools\maestro\bin\maestro.bat"
if (Test-Path $maestro) {
  try {
    $version = & $maestro --version 2>&1
    Add-Result "maestro" "PASS" (($version | Out-String).Trim())
  } catch {
    Add-Result "maestro" "WARN" "maestro exists but --version failed: $($_.Exception.Message)"
  }
} else {
  Add-Result "maestro" "WARN" "not found at $maestro"
}

if ($Json) {
  $results | ConvertTo-Json -Depth 3
} else {
  $results | Format-Table -AutoSize | Out-String | Write-Host
}

$failed = @($results | Where-Object { $_.Status -eq "FAIL" })
if ($failed.Count -gt 0) { exit 1 }
exit 0
