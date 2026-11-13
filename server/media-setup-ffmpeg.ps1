$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$destination = Join-Path $root '.tools/ffmpeg'
$scratch = Join-Path $root ('.tools/ffmpeg-download-' + [guid]::NewGuid().ToString('N'))
$source = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'

if ((Test-Path (Join-Path $destination 'ffmpeg.exe')) -and (Test-Path (Join-Path $destination 'ffprobe.exe'))) {
    Write-Output "FFmpeg is already available in $destination"
    exit 0
}

New-Item -ItemType Directory -Path $scratch -Force | Out-Null
try {
    $archive = Join-Path $scratch 'ffmpeg.zip'
    $expected = & curl.exe --fail --location --silent --show-error --retry 2 --max-time 60 ($source + '.sha256')
    if ($LASTEXITCODE -ne 0 -or $expected -notmatch '^[0-9a-fA-F]{64}(\s|$)') { throw 'Failed to retrieve the FFmpeg SHA-256 checksum.' }
    $checksum = ($expected -split '\s+')[0]
    & curl.exe --fail --location --retry 2 --max-time 300 --output $archive $source
    if ($LASTEXITCODE -ne 0 -or (Get-FileHash -LiteralPath $archive).Hash -ne $checksum) { throw 'FFmpeg archive verification failed.' }
    Expand-Archive -LiteralPath $archive -DestinationPath $scratch
    $encoder = Get-ChildItem -LiteralPath $scratch -Recurse -File -Filter 'ffmpeg.exe' | Select-Object -First 1
    $probe = Get-ChildItem -LiteralPath $scratch -Recurse -File -Filter 'ffprobe.exe' | Select-Object -First 1
    if (!$encoder -or !$probe) { throw 'The FFmpeg archive is missing required binaries.' }
    New-Item -ItemType Directory -Path $destination -Force | Out-Null
    Copy-Item -LiteralPath $encoder.FullName, $probe.FullName -Destination $destination
    Write-Output "FFmpeg installed in $destination"
} finally {
    $checked = (Resolve-Path -LiteralPath $scratch).Path
    $toolsPath = (Resolve-Path -LiteralPath (Join-Path $root '.tools')).Path
    if ((Split-Path -Parent $checked) -eq $toolsPath -and (Split-Path -Leaf $checked) -like 'ffmpeg-download-*') {
        Remove-Item -LiteralPath $checked -Recurse -Force
    }
}
