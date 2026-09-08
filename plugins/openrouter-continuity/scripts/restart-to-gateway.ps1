param(
  [Parameter(Mandatory = $true)]
  [string]$DataDir,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

function Write-RecoveryStatus([string]$State, [string]$Detail = '') {
  [IO.Directory]::CreateDirectory($DataDir) | Out-Null
  $payload = [ordered]@{
    at = [DateTime]::UtcNow.ToString('o')
    state = $State
    detail = if ($Detail.Length -gt 160) { $Detail.Substring(0, 160) } else { $Detail }
  } | ConvertTo-Json -Compress
  $tempPath = Join-Path $DataDir ([Guid]::NewGuid().ToString() + '.tmp')
  $finalPath = Join-Path $DataDir 'recovery-status.json'
  [IO.File]::WriteAllText($tempPath, $payload, [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $tempPath -Destination $finalPath -Force
}

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

if ($DryRun) {
  [ordered]@{
    ready = $true
    platform = 'windows'
    wouldCloseClaudeNormally = $true
    wouldForceKill = $false
    wouldSelectConfiguredGateway = $true
  } | ConvertTo-Json -Compress
  exit 0
}

$createdNew = $false
$mutex = [Threading.Mutex]::new($true, 'Local\ClaudeOpenRouterContinuity', [ref]$createdNew)
if (-not $createdNew) { exit 0 }

try {
  Start-Sleep -Seconds 2
  Write-RecoveryStatus 'closing_claude'
  $claudeProcesses = @(Get-Process -Name 'Claude' -ErrorAction SilentlyContinue)
  foreach ($processItem in $claudeProcesses) {
    if ($processItem.MainWindowHandle -ne 0) { [void]$processItem.CloseMainWindow() }
  }

  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  do {
    Start-Sleep -Milliseconds 300
    $remaining = @(Get-Process -Name 'Claude' -ErrorAction SilentlyContinue)
  } while ($remaining.Count -gt 0 -and [DateTime]::UtcNow -lt $deadline)

  if ($remaining.Count -gt 0) {
    Write-RecoveryStatus 'close_blocked' 'Claude did not close normally; no process was force-killed.'
    exit 2
  }

  Write-RecoveryStatus 'launching_claude'
  Start-Process -FilePath 'explorer.exe' -ArgumentList 'shell:AppsFolder\Claude_pzs8sxrjxfjjc!Claude'

  $buttonNames = @(
    'Continue with Gateway', 'Continuar com Gateway',
    'Local configuration', 'Configuração local'
  )
  $buttonType = [Windows.Automation.ControlType]::Button
  $buttonCondition = [Windows.Automation.PropertyCondition]::new(
    [Windows.Automation.AutomationElement]::ControlTypeProperty, $buttonType)
  $choiceDeadline = [DateTime]::UtcNow.AddSeconds(60)

  do {
    Start-Sleep -Milliseconds 500
    $claudeWindows = @(Get-Process -Name 'Claude' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 })
    foreach ($claudeWindow in $claudeWindows) {
      $windowElement = [Windows.Automation.AutomationElement]::FromHandle($claudeWindow.MainWindowHandle)
      $buttons = $windowElement.FindAll([Windows.Automation.TreeScope]::Descendants, $buttonCondition)
      foreach ($button in $buttons) {
        if ($buttonNames -contains $button.Current.Name) {
          $invoke = $button.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern)
          $invoke.Invoke()
          Write-RecoveryStatus 'gateway_selected'
          exit 0
        }
      }
    }
  } while ([DateTime]::UtcNow -lt $choiceDeadline)

  Write-RecoveryStatus 'gateway_choice_not_found' 'Configure Third-Party Inference before arming recovery.'
  exit 3
} catch {
  Write-RecoveryStatus 'recovery_failed' $_.Exception.GetType().Name
  exit 1
} finally {
  if ($createdNew) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
