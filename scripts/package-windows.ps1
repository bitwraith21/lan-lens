param(
    [Parameter(Mandatory)] [string] $Stage,
    [Parameter(Mandatory)] [string] $LlvmBin,
    [Parameter(Mandatory)] [string] $WixBin,
    [Parameter(Mandatory)] [string] $Output,
    [switch] $SkipIceValidation
)
$ErrorActionPreference = 'Stop'
$project = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Stage = (Resolve-Path $Stage).Path
$LlvmBin = (Resolve-Path $LlvmBin).Path
$WixBin = (Resolve-Path $WixBin).Path
$Output = [IO.Path]::GetFullPath($Output)
$build = Join-Path (Split-Path $Stage) 'msi-obj'
New-Item -ItemType Directory -Force $build, (Split-Path $Output) | Out-Null
$preflight = Join-Path $build 'preflight.dll'
& "$LlvmBin/clang.exe" -std=c17 -O2 -Wall -Wextra -Werror -shared "$project/installer/preflight.c" -lmsi -lversion -ladvapi32 -o $preflight
if ($LASTEXITCODE) { throw 'Installer prerequisite check could not be compiled' }
$rtf = Join-Path $build 'license.rtf'
$license = (Get-Content -Raw "$project/LICENSE").Replace('\','\\').Replace('{','\{').Replace('}','\}')
$license = $license -replace '\r?\n', "\par`n"
("{\rtf1\ansi\deff0{\fonttbl{\f0 Arial;}}\f0\fs18 " + $license + "}") |
    Set-Content -Encoding ascii $rtf
$notices = Join-Path $build 'third-party.txt'
$noticeText = Get-ChildItem "$project/licenses" -File | ForEach-Object {
    $_.BaseName
    Get-Content -Raw -LiteralPath $_.FullName
}
$noticeText | Set-Content -Encoding utf8 $notices
$wixobj = Join-Path $build 'LANLens.wixobj'
& "$WixBin/candle.exe" -nologo -arch x64 -ext "$WixBin/WixFirewallExtension.dll" `
    "-dStage=$Stage" "-dPreflight=$preflight" "-dLicenseRtf=$rtf" "-dCopying=$project/LICENSE" "-dNotices=$notices" -out $wixobj "$project/installer/LANLens.wxs"
if ($LASTEXITCODE) { throw 'WiX could not compile the package source' }
$linkArguments = @(
    '-nologo', '-ext', "$WixBin/WixFirewallExtension.dll", '-ext', "$WixBin/WixUIExtension.dll",
    '-pdbout', "$build/LANLens.wixpdb", '-out', $Output, $wixobj
)
if ($SkipIceValidation) { $linkArguments += '-sval' }
& "$WixBin/light.exe" @linkArguments
if ($LASTEXITCODE) { throw 'WiX could not link or validate the MSI' }
Write-Output $Output




