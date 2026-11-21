# prepare.ps1・run.ps1・check.ps1・stop.ps1 が読む。置き場所と node の探し方、この app のプロセスの見つけ方を決める。
$App = "yunomi-voice"
$AppRoot = "C:\apps\$App"
$DataDir = Join-Path $AppRoot "data"
$LogDir = Join-Path $DataDir "logs"
$ConfigDir = Join-Path $env:ProgramData $App
$ReleaseDir = Split-Path -Parent $PSScriptRoot

function Get-ReleaseVersion([string]$Dir) {
    $file = Join-Path $Dir "release.json"
    if (-not (Test-Path -LiteralPath $file)) { return $null }
    (Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json).version
}

# Node は同梱せず、持ち主が入れたものを使う
function Get-Node {
    if ($env:NODE) { return $env:NODE }
    (Get-Command node -ErrorAction Stop).Source
}

# config.json と tokens.json は、どちらも環境変数の名前から文字列への平らなオブジェクト
function Read-EnvFile([string]$Name) {
    $file = Join-Path $ConfigDir $Name
    if (-not (Test-Path -LiteralPath $file)) { throw "$file がない" }
    $values = [ordered]@{}
    $json = Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($p in $json.PSObject.Properties) {
        if ($p.Name -cnotmatch '^[A-Z][A-Z0-9_]*$') { throw "$file の $($p.Name) は環境変数の名前でない" }
        if ($p.Value -isnot [string]) { throw "$file の $($p.Name) が文字列でない" }
        $values[$p.Name] = $p.Value
    }
    $values
}

# どの版の node.exe かをコマンドラインで見分けられるよう、run.ps1 は releases\<版>\src\main.ts を渡す
function Get-AppProcess {
    $root = [regex]::Escape($AppRoot)
    @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe' OR Name = 'cmd.exe' OR Name = 'powershell.exe' OR Name = 'pwsh.exe'" |
        Where-Object { $_.CommandLine -match "$root\\[^`"]*\\src\\main\.ts" -or $_.CommandLine -match "$root\\[^`"]*\\deploy\\run\.ps1" } |
        Where-Object { $_.ProcessId -ne $PID })
}
