param(
    [Parameter(Mandatory)] [string] $ObsRoot,
    [Parameter(Mandatory)] [string] $ObsSdk,
    [Parameter(Mandatory)] [string] $BrowserSdk,
    [Parameter(Mandatory)] [string] $QtSdk,
    [Parameter(Mandatory)] [string] $LlvmBin,
    [string] $MsvcSdk,
    [string] $Go = 'go.exe',
    [string] $Build = (Join-Path $PSScriptRoot '..\build')
)
$ErrorActionPreference = 'Stop'
$project = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$ObsRoot = (Resolve-Path $ObsRoot).Path
$ObsSdk = (Resolve-Path $ObsSdk).Path
$BrowserSdk = (Resolve-Path $BrowserSdk).Path
$QtSdk = (Resolve-Path $QtSdk).Path
$LlvmBin = (Resolve-Path $LlvmBin).Path
$Go = (Get-Command $Go).Source
$Build = [IO.Path]::GetFullPath($Build)
$native = Join-Path $project 'native'
$plugin = Join-Path $Build 'lan-lens'
$obj = Join-Path $Build 'obj'
New-Item -ItemType Directory -Force "$plugin/data", $obj | Out-Null

# Qt and OBS Browser use the MSVC C++ ABI on Windows.
$clang = Join-Path $LlvmBin 'clang-cl.exe'
if (!(Test-Path -LiteralPath $clang)) {
    $clang = (Get-ChildItem -LiteralPath $LlvmBin -Filter 'clang-*.exe' |
        Where-Object Name -match '^clang-\d+\.exe$' | Select-Object -First 1).FullName
}
if (!$clang) { throw 'The LLVM Clang compiler was not found.' }
$linker = Join-Path $LlvmBin 'lld-link.exe'
$linkFlags = @()
if (!(Test-Path -LiteralPath $linker)) {
    $linker = Join-Path $LlvmBin 'ld.lld.exe'
    $linkFlags += '-flavor', 'link'
}
$compileFlags = @(
    '--driver-mode=cl', '--target=x86_64-pc-windows-msvc', '/nologo', '/c', '/O2', '/MD', '/utf-8', '/W4', '/D_CRT_SECURE_NO_WARNINGS', "/FI$native/clang-msvc-compat.h",
    "/I$native", "/I$ObsSdk/libobs", "/I$ObsSdk/frontend/api", "/I$BrowserSdk"
)
foreach ($module in '', 'QtCore', 'QtGui', 'QtWidgets') {
    $qtInclude = if ($module) { "$QtSdk/include/$module" } else { "$QtSdk/include" }
    $compileFlags += "/imsvc$qtInclude"
}
if ($MsvcSdk) {
    $MsvcSdk = (Resolve-Path $MsvcSdk).Path
    foreach ($include in 'crt/include', 'sdk/include/ucrt', 'sdk/include/shared', 'sdk/include/um') {
        $compileFlags += "/imsvc$MsvcSdk/$include"
    }
    foreach ($dir in 'crt/lib/x86_64', 'sdk/lib/ucrt/x86_64', 'sdk/lib/um/x86_64') {
        $linkFlags += "/LIBPATH:$MsvcSdk/$dir"
    }
} elseif (!$env:INCLUDE -or !$env:LIB) {
    throw 'Use a Visual Studio x64 Developer PowerShell or pass the unpacked xwin SDK with -MsvcSdk.'
}

foreach ($dll in 'obs','obs-frontend-api') {
    $exports = & "$LlvmBin/llvm-readobj.exe" --coff-exports "$ObsRoot/bin/64bit/$dll.dll"
    if ($LASTEXITCODE) { throw "Could not read exports from $dll.dll" }
    $symbols = $exports | ForEach-Object { if ($_ -match '^\s+Name:\s+(\S+)$') { $Matches[1] } }
    @("LIBRARY $dll.dll", 'EXPORTS') + $symbols | Set-Content -Encoding ascii "$obj/$dll.def"
    & "$LlvmBin/llvm-lib.exe" "/DEF:$obj/$dll.def" "/OUT:$obj/$dll.lib" /MACHINE:X64
    if ($LASTEXITCODE) { throw "Could not create import library for $dll.dll" }
}
foreach ($file in 'plugin.c', 'process_windows.c', 'dock.cpp') {
    $flags = @('/std:c17')
    if ($file.EndsWith('.cpp')) { $flags = @('/std:c++20', '/EHsc', '/Zc:__cplusplus') }
    & $clang @compileFlags @flags "/Fo$obj/$file.obj" "$native/$file"
    if ($LASTEXITCODE) { throw "Could not compile $file" }
}
$linkFlags += @(
    '/DLL', '/MACHINE:X64', '/Brepro', "/OUT:$plugin/lan-lens.dll", "/IMPLIB:$obj/lan-lens.lib",
    "$obj/plugin.c.obj", "$obj/process_windows.c.obj", "$obj/dock.cpp.obj",
    "$obj/obs.lib", "$obj/obs-frontend-api.lib",
    "$QtSdk/lib/Qt6Widgets.lib", "$QtSdk/lib/Qt6Gui.lib", "$QtSdk/lib/Qt6Core.lib", 'shell32.lib'
)
& $linker @linkFlags
if ($LASTEXITCODE) { throw 'OBS plugin link failed' }

Push-Location "$project/server"
try {
    $env:CGO_ENABLED = '0'
    $env:GOOS = 'windows'
    $env:GOARCH = 'amd64'
    & $Go build -trimpath -ldflags '-s -w' -o "$plugin/data/lanlens-server.exe" .
    if ($LASTEXITCODE) { throw 'Companion build failed' }
} finally { Pop-Location }
Write-Output $plugin
