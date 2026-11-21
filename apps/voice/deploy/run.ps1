# タスク yunomi-voice が起動する。C:\ProgramData\yunomi-voice の設定を環境変数にして、版の src\main.ts を node と tsx で前面で動かし、その終了コードで終わる。
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "common.ps1")

# タスクは current\deploy\run.ps1 を指すので、current の向き先の版のフォルダで動かす。check.ps1 と stop.ps1 がコマンドラインで版を見分ける
$version = Get-ReleaseVersion $ReleaseDir
$dir = $ReleaseDir
if ($version -and (Test-Path -LiteralPath (Join-Path $AppRoot "releases\$version"))) {
    $dir = Join-Path $AppRoot "releases\$version"
}
$node = Get-Node
$main = Join-Path $dir "src\main.ts"

foreach ($name in @("config.json", "tokens.json")) {
    $values = Read-EnvFile $name
    foreach ($key in $values.Keys) {
        [Environment]::SetEnvironmentVariable($key, $values[$key], "Process")
    }
}
$env:NODE_ENV = "production"

# ログは起動した日のファイルに足していき、14 日より古いものは消す
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
Get-ChildItem -LiteralPath $LogDir -Filter "*.log" -File |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-14) } |
    Remove-Item -Force -ErrorAction SilentlyContinue
$log = Join-Path $LogDir ("$App-" + (Get-Date -Format "yyyyMMdd") + ".log")
$utf8 = New-Object Text.UTF8Encoding $false
[IO.File]::AppendAllText($log, "== start $App $version at $((Get-Date).ToString('o')) ($node)`r`n", $utf8)

# 5.1 のリダイレクトは stderr の 1 行目で止まり、文字コードも崩れるので、node の出力は cmd にそのままファイルへ書かせる
$line = "/d /s /c `"`"$node`" --import tsx `"$main`" >> `"$log`" 2>&1`""
$p = Start-Process -FilePath "cmd.exe" -ArgumentList $line -WorkingDirectory $dir -NoNewWindow -PassThru
# 5.1 では、終わる前にハンドルを開いておかないと ExitCode を読めない
$null = $p.Handle
$p.WaitForExit()
[IO.File]::AppendAllText($log, "== exit $App $version code $($p.ExitCode) at $((Get-Date).ToString('o'))`r`n", $utf8)
exit $p.ExitCode
