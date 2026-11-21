# 配備した版の node.exe が起動し、20 秒たっても同じプロセスが動き続けているかを確かめる。
# yunomi-voice は受ける口を持たないので応答は確かめない。設定の誤りや Discord へのログインの失敗はプロセスが終わることで分かるが、
# Worker や ochoko・kukicha に届くかは確かめない。配備ワークフローが、タスクを起こした後に実行する。
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "common.ps1")

$expected = Get-ReleaseVersion $ReleaseDir
if (-not $expected) { throw "$ReleaseDir\release.json がない" }
$main = Join-Path $AppRoot "releases\$expected\src\main.ts"

function Get-ReleaseNodeProcess {
    @(Get-AppProcess | Where-Object { $_.Name -eq "node.exe" -and $_.CommandLine -like "*$main*" })
}

function Show-LogTail {
    $log = Get-ChildItem -LiteralPath $LogDir -Filter "*.log" -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($log) {
        Write-Host "--- $($log.FullName) の末尾"
        Get-Content -LiteralPath $log.FullName -Tail 20 -Encoding UTF8 | Out-Host
    }
}

$deadline = (Get-Date).AddSeconds(60)
$proc = $null
while ((Get-Date) -lt $deadline) {
    $found = Get-ReleaseNodeProcess
    if ($found.Count -gt 0) { $proc = $found[0]; break }
    Start-Sleep -Seconds 2
}
if (-not $proc) {
    Write-Host "$expected の node.exe が 60 秒以内に起動しなかった"
    Show-LogTail
    exit 1
}
Write-Host "==> $expected の node.exe (pid $($proc.ProcessId)) が起動した。20 秒動き続けるか見る"

Start-Sleep -Seconds 20
$still = Get-ReleaseNodeProcess | Where-Object { $_.ProcessId -eq $proc.ProcessId }
if (-not $still) {
    Write-Host "$expected の node.exe (pid $($proc.ProcessId)) が 20 秒以内に終わった"
    Show-LogTail
    exit 1
}
Write-Host "check ok: version=$expected pid=$($proc.ProcessId)"
exit 0
