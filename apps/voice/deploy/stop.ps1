# 版を止めるとき、配備ワークフローがタスクより先に実行する(作業フォルダは止める版、引数なし)。
# タスクを止めても、run.ps1 が起こした cmd.exe と node.exe や手で起動したものは残って Discord の接続を持ち続けるので、
# C:\apps\yunomi-voice の下を動かしているものをどの版でもプロセスツリーごと終わらせる。
# 終了コード 0 で成功。プロセスが残れば 1 を返し、配備は失敗する。
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "common.ps1")

if (Get-ScheduledTask -TaskName $App -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $App -ErrorAction SilentlyContinue
}

foreach ($p in Get-AppProcess) {
    Write-Host "==> $($p.Name) (pid $($p.ProcessId)) をプロセスツリーごと終了する"
    $previous = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    & taskkill.exe /PID $p.ProcessId /T /F 2>&1 | Out-Host
    $ErrorActionPreference = $previous
}

$deadline = (Get-Date).AddSeconds(15)
while ($true) {
    $left = @(Get-AppProcess)
    if ($left.Count -eq 0) { break }
    if ((Get-Date) -gt $deadline) {
        Write-Host "$App のプロセスが終了しない: pid $(($left | ForEach-Object { $_.ProcessId }) -join ', ')"
        exit 1
    }
    Start-Sleep -Milliseconds 500
}
Write-Host "$App は止まっている"
exit 0
