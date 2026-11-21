# 版を配備するとき、配備ワークフローが stop.ps1 より先に実行する(作業フォルダは新しい版、引数なし)。
# 依存は zip に入っているので取りに行かない。動いている版を止める前に、新しい版が起動できる前提を確かめる。
#   - node が見つかり、版が 24 以上
#   - C:\ProgramData\yunomi-voice の config.json と tokens.json が読め、必須の DISCORD_TOKEN と YUNOMI_URL がある
# ffmpeg がなくても起動はするので、警告だけにする。終了コード 0 で成功。
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "common.ps1")

$node = Get-Node
$nodeVersion = (& $node --version).Trim()
if ($LASTEXITCODE -ne 0) { throw "$node --version が失敗した" }
if ($nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 24) {
    throw "Node 24 以上が要る（$node は $nodeVersion）"
}
Write-Host "==> node: $node $nodeVersion"

$names = @()
foreach ($file in @("config.json", "tokens.json")) {
    $names += @((Read-EnvFile $file).Keys)
}
foreach ($required in @("DISCORD_TOKEN", "YUNOMI_URL")) {
    if ($names -notcontains $required) { throw "$ConfigDir の config.json と tokens.json のどちらにも $required がない" }
}
Write-Host "==> 設定: $(($names | Sort-Object) -join ', ')"

if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    Write-Host "::warning::ffmpeg が PATH にない。VC で声を再生できない"
}
Write-Host "prepare ok: $(Get-ReleaseVersion $ReleaseDir)"
exit 0
