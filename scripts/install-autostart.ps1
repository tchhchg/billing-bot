<#
.SYNOPSIS
  给 billing-bot 注册/删除 Windows 计划任务：每天定时生成日报。

.DESCRIPTION
  为什么用计划任务而不是"常驻进程"：
  常驻进程会因关机/休眠漏跑，靠幂等补跑能救回来，但计划任务更省心、也不占内存。
  两种方式都支持，二选一即可：
    · 计划任务（本脚本）：每天定时跑一次 --run-daily，跑完即退
    · 常驻服务（node src/main.ts）：带本地界面 + 每分钟检查

.EXAMPLE
  pwsh -File scripts/install-autostart.ps1 -Action install -Time 21:00
  pwsh -File scripts/install-autostart.ps1 -Action status
  pwsh -File scripts/install-autostart.ps1 -Action remove
#>
[CmdletBinding()]
param(
  [ValidateSet('install', 'remove', 'status', 'run-now')]
  [string]$Action = 'status',
  [string]$Time = '21:00',
  [string]$TaskName = 'billing-bot daily',
  [string]$DataDir = '',
  [string]$NodePath = ''
)

$ErrorActionPreference = 'Stop'

$projectDir = Split-Path -Parent $PSScriptRoot
$entry = Join-Path $projectDir 'src\main.ts'
if (-not (Test-Path $entry)) { throw "找不到入口文件：$entry" }

if ([string]::IsNullOrWhiteSpace($NodePath)) {
  $NodePath = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $NodePath) { throw '未找到 node，可用 -NodePath 显式指定' }
}

$nodeArgs = "`"$entry`" --run-daily --no-server --no-scheduler"

# 计划任务不继承工作目录。默认数据目录是 %LOCALAPPDATA%\billing-bot，
# 不需要环境变量；只有显式指定 -DataDir 时才用 cmd 包一层设环境变量。
if ([string]::IsNullOrWhiteSpace($DataDir)) {
  $action = New-ScheduledTaskAction -Execute $NodePath -Argument $nodeArgs -WorkingDirectory $projectDir
} else {
  $action = New-ScheduledTaskAction -Execute 'cmd.exe' `
    -Argument "/c set `"BILLING_BOT_HOME=$DataDir`" && `"$NodePath`" $nodeArgs" `
    -WorkingDirectory $projectDir
}

function Show-Status {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if (-not $task) { Write-Host "未注册计划任务「$TaskName」"; return }
  $info = Get-ScheduledTaskInfo -TaskName $TaskName
  Write-Host "任务：$TaskName"
  Write-Host "状态：$($task.State)"
  Write-Host "上次：$($info.LastRunTime) → $($info.LastTaskResult)"
  Write-Host "下次：$($info.NextRunTime)"
  Write-Host "命令：$($task.Actions[0].Execute) $($task.Actions[0].Arguments)"
}

switch ($Action) {
  'install' {
    $trigger = New-ScheduledTaskTrigger -Daily -At $Time
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd `
      -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
    Write-Host "已注册计划任务「$TaskName」，每天 $Time 执行（尊重幂等：当天已推送过会自动跳过）。"
    Show-Status
  }
  'remove' {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "已删除计划任务「$TaskName」。"
  }
  'run-now' {
    Start-ScheduledTask -TaskName $TaskName
    Write-Host '已触发一次；稍后用 -Action status 查看结果。'
  }
  'status' { Show-Status }
}
