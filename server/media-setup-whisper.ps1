param([switch] $CompactModel)

$ErrorActionPreference = 'Stop'
$tools = Join-Path (Split-Path -Parent $PSScriptRoot) '.tools/whisper'
New-Item -ItemType Directory -Path $tools -Force | Out-Null

function Save-VerifiedFile([string] $Uri, [string] $Destination, [string] $Sha256) {
    if ((Test-Path -LiteralPath $Destination) -and ((Get-FileHash -LiteralPath $Destination).Hash -eq $Sha256)) {
        return
    }
    $pending = "$Destination.download"
    & curl.exe --fail --location --retry 2 --max-time 300 --output $pending $Uri
    if ($LASTEXITCODE -ne 0) { throw "Download failed ($LASTEXITCODE): $Uri" }
    if ((Get-FileHash -LiteralPath $pending).Hash -ne $Sha256) {
        Remove-Item -LiteralPath $pending -Force
        throw "Checksum mismatch: $Uri"
    }
    Move-Item -LiteralPath $pending -Destination $Destination -Force
}

$bin = Join-Path $tools 'bin'
$cli = Get-ChildItem -LiteralPath $bin -Filter 'whisper-cli.exe' -Recurse -File -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $cli) {
    $archive = Join-Path $tools 'whisper-bin-x64.zip'
    Save-VerifiedFile `
        'https://github.com/ggml-org/whisper.cpp/releases/download/v1.8.3/whisper-bin-x64.zip' `
        $archive 'd824b1e37599f882b396e73f1ee0bfd5d0529f700314c48311dcbd00b803321d'
    Expand-Archive -LiteralPath $archive -DestinationPath $bin -Force
    $cli = Get-ChildItem -LiteralPath $bin -Filter 'whisper-cli.exe' -Recurse -File | Select-Object -First 1
    if (-not $cli) { throw 'whisper-cli.exe is missing from the release archive.' }
    Remove-Item -LiteralPath $archive -Force
}

if ($CompactModel) {
    $modelName = 'ggml-base-q5_1.bin'
    $modelSha = '422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898'
} else {
    $modelName = 'ggml-base.bin'
    $modelSha = '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe'
}

$model = Join-Path $tools $modelName
$source = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$modelName"
try {
    Save-VerifiedFile $source $model $modelSha
} catch {
    if ($CompactModel) { throw }
    Write-Output 'Trying Telestream for the same SHA-256 verified multilingual base model.'
    Save-VerifiedFile 'https://www.telestream.net/download-files/ggml/ggml-base.bin' $model $modelSha
}

# The CLI writes its help to stderr even when startup succeeds.
$ErrorActionPreference = 'Continue'
& $cli.FullName --help 2>$null
if ($LASTEXITCODE -ne 0) { throw 'whisper-cli.exe did not start successfully.' }
Write-Output "Installed $($cli.FullName) with $model."
