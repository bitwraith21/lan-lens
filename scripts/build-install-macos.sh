#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
OBS_APP="${OBS_APP:-/Applications/OBS.app}"
PLUGIN_ROOT="$HOME/Library/Application Support/obs-studio/plugins"
SDK="${OBS_SDK:-$ROOT/build/obs-sdk}"
BUILD="$ROOT/build/macos"
MODULE="$BUILD/lan-lens.plugin"
MODE="${1:-install}"
if [[ "$MODE" != install && "$MODE" != --build-only ]]; then
    echo "Usage: bash scripts/build-install-macos.sh [--build-only]" >&2
    exit 2
fi

missing=()
[[ "$(uname -s)" == Darwin ]] || { echo "Run this command on macOS." >&2; exit 1; }
for cmd in git go xcrun codesign lipo curl shasum; do
    command -v "$cmd" >/dev/null || missing+=("$cmd")
done
xcrun --find clang >/dev/null 2>&1 || missing+=("Xcode Command Line Tools (xcode-select --install)")
[[ -x "$OBS_APP/Contents/MacOS/OBS" || -x "$OBS_APP/Contents/MacOS/obs" ]] || missing+=("OBS Studio at $OBS_APP")
if [[ -f "$OBS_APP/Contents/Info.plist" ]]; then
    version=$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$OBS_APP/Contents/Info.plist")
    case "$version" in
        33.0.0|33.0|33) missing+=("OBS Studio 33.0.1 or a later 33.x release") ;;
        33.*) ;;
        *) missing+=("OBS Studio 33.0.1 or a later 33.x release (found $version)") ;;
    esac
    browser=$(find "$OBS_APP/Contents" \( -name 'obs-browser.plugin' -o -name 'obs-browser.so' -o -name 'obs-browser' \) -print | head -n 1)
    [[ -n "$browser" ]] || missing+=("OBS Browser Source (use the full OBS installer)")
fi
if (( ${#missing[@]} )); then
    printf 'Missing prerequisites\n' >&2
    printf '  %s\n' "${missing[@]}" >&2
    exit 1
fi
go_toolchain=$(go env GOVERSION)
if [[ ! "$go_toolchain" =~ ^go1\.([0-9]+) ]] || (( BASH_REMATCH[1] < 25 )); then
    echo "Go 1.25 or newer is required (found $go_toolchain)." >&2
    exit 1
fi

obs_running() { pgrep -x OBS >/dev/null || pgrep -x obs >/dev/null; }
if [[ "$MODE" == install ]] && obs_running; then
    echo "Close OBS Studio before installing LAN Lens." >&2
    exit 1
fi

mkdir -p "$ROOT/build" "$BUILD"
if [[ ! -f "$SDK/libobs/obs-module.h" ]]; then
    if [[ -n "${OBS_SDK:-}" ]]; then
        echo "OBS_SDK must point to the OBS Studio 33.0.1 source checkout." >&2
        exit 1
    fi
    git clone --depth 1 --branch 33.0.1 https://github.com/obsproject/obs-studio.git "$SDK"
fi
BROWSER_SDK="${OBS_BROWSER_SDK:-$ROOT/build/obs-browser-sdk}"
if [[ ! -f "$BROWSER_SDK/panel/browser-panel.hpp" ]]; then
    if [[ -n "${OBS_BROWSER_SDK:-}" ]]; then
        echo "OBS_BROWSER_SDK must contain the OBS 33.0.1 browser panel header." >&2
        exit 1
    fi
    mkdir -p "$BROWSER_SDK/panel"
    browser_commit=d4db73e7e5d5b51d853177c8cddc796715a8ac84
    curl -fLSs "https://raw.githubusercontent.com/obsproject/obs-browser/$browser_commit/panel/browser-panel.hpp" \
        -o "$BROWSER_SDK/panel/browser-panel.hpp.tmp"
    mv "$BROWSER_SDK/panel/browser-panel.hpp.tmp" "$BROWSER_SDK/panel/browser-panel.hpp"
fi

QT_SDK="${OBS_QT_SDK:-$ROOT/build/obs-qt-2026-10-23}"
if [[ ! -d "$QT_SDK/lib/QtWidgets.framework" ]]; then
    if [[ -n "${OBS_QT_SDK:-}" ]]; then
        echo "OBS_QT_SDK must point to the OBS Qt SDK containing lib/QtWidgets.framework." >&2
        exit 1
    fi
    mkdir -p "$QT_SDK"
    qt_asset=macos-deps-qt6-2026-10-23-universal.tar.xz
    archive="$ROOT/build/$qt_asset"
    curl -fLSs "https://github.com/obsproject/obs-deps/releases/download/2026-10-23/$qt_asset" -o "$archive"
    printf '%s  %s\n' b216560cea8497207f9fc350c713716fb84aec6b973bb0ff8ac6add7734abad5 "$archive" | shasum -a 256 -c
    tar -xf "$archive" -C "$QT_SDK"
fi

mkdir -p "$MODULE/Contents/MacOS" "$MODULE/Contents/Resources"
cp "$ROOT/native/Info.plist" "$MODULE/Contents/Info.plist"
bins=()
if [[ -x "$OBS_APP/Contents/MacOS/OBS" ]]; then obs_bin="$OBS_APP/Contents/MacOS/OBS"; else obs_bin="$OBS_APP/Contents/MacOS/obs"; fi
for arch in $(lipo -archs "$obs_bin"); do
    case "$arch" in arm64) goarch=arm64 ;; x86_64) goarch=amd64 ;; *) echo "Unsupported OBS architecture: $arch"; exit 1 ;; esac
    (cd "$ROOT/server"; GOOS=darwin GOARCH="$goarch" CGO_ENABLED=0 go build -trimpath -ldflags '-s -w' -o "$BUILD/lanlens-server-$arch" .)
    bins+=("$BUILD/lanlens-server-$arch")
done
flags=()
for arch in $(lipo -archs "$obs_bin"); do flags+=(-arch "$arch"); done
native_flags=("${flags[@]}" -mmacosx-version-min=13.0 -Wall -Wextra -O2
    -I "$ROOT/native" -I "$SDK/libobs" -I "$SDK/frontend/api")
for file in plugin process_macos; do
    xcrun clang "${native_flags[@]}" -std=c17 -c "$ROOT/native/$file.c" -o "$BUILD/$file.o"
done
qt_frameworks="$QT_SDK/lib"
xcrun clang++ "${native_flags[@]}" -std=c++20 -I "$BROWSER_SDK" -F "$qt_frameworks" \
    -isystem "$qt_frameworks/QtCore.framework/Headers" -isystem "$qt_frameworks/QtGui.framework/Headers" \
    -isystem "$qt_frameworks/QtWidgets.framework/Headers" -bundle -undefined dynamic_lookup \
    -Wl,-rpath,@executable_path/../Frameworks -framework QtCore -framework QtGui -framework QtWidgets \
    "$ROOT/native/dock.cpp" "$BUILD/plugin.o" "$BUILD/process_macos.o" -o "$MODULE/Contents/MacOS/lan-lens"
if (( ${#bins[@]} == 1 )); then
    cp "${bins[0]}" "$MODULE/Contents/Resources/lanlens-server"
else
    lipo -create "${bins[@]}" -output "$MODULE/Contents/Resources/lanlens-server"
fi
codesign --force --sign - "$MODULE/Contents/Resources/lanlens-server"
codesign --force --sign - "$MODULE"
codesign --verify --strict "$MODULE"

if [[ "$MODE" == --build-only ]]; then
    printf 'Built %s\n' "$MODULE"
    exit 0
fi
if obs_running; then
    echo "OBS was opened during the build. Close it before installing." >&2
    exit 1
fi
mkdir -p "$PLUGIN_ROOT"
stage=$(mktemp -d "$PLUGIN_ROOT/.lan-lens-install.XXXXXX")
ditto "$MODULE" "$stage/lan-lens.plugin"
target="$PLUGIN_ROOT/lan-lens.plugin"
previous=""
if [[ -e "$target" ]]; then
    mkdir -p "$PLUGIN_ROOT/../lan-lens-backups"
    previous="$PLUGIN_ROOT/../lan-lens-backups/lan-lens-$(date +%Y%m%d-%H%M%S)-$$.plugin"
    mv "$target" "$previous"
fi
if ! mv "$stage/lan-lens.plugin" "$target"; then
    if [[ -n "$previous" ]]; then mv "$previous" "$target"; fi
    echo "Unable to install LAN Lens." >&2
    exit 1
fi
rmdir "$stage"
printf 'Installed %s\nOpen OBS → Docks → LAN Lens for OBS.\n' "$target"
