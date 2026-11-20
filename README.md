# LAN Lens for OBS

Use your phones as additional camera share feeds with local displays. LAN Lens supports upto 32 feeds and streams audio and video directly over WebRTC on your LAN.

## Watch the demo here
[![Watch the demo](https://img.youtube.com/vi/1TNtRQI8cwU/maxresdefault.jpg)](https://www.youtube.com/watch?v=1TNtRQI8cwU)


## Support the project
[<img src="assets/kofi6.webp" alt="Support this project" width="200">](https://ko-fi.com/bitwraith21)


## Install and pair

1. **Windows x64.** Close OBS and run the MSI from GitHub Releases. Use the full OBS Studio 33.x build, version 33.0.1 or later. The MSI is unsigned, so Windows may show **Unknown publisher**.
2. Open **Docks → LAN Lens for OBS**. Connect the phone and OBS computer to the same LAN.
3. In the dock, choose **Settings → Phone certificate download**. Check the fingerprint and follow the phone’s trust instructions. If the phone already trusts the host’s HTTPS certificate, skip this step.
4. Choose **Pair camera** or **Pair display**. Scan the QR or enter the six-character code. Codes expire after five minutes and work once. On the phone, tap **Start camera** and grant camera and microphone access.
5. Click **Add to OBS** on the feed. In Studio Mode, this targets Preview. LAN Lens reuses the Browser Source across scenes.

## Controls

- **Phone.** Use **Install app** to add LAN Lens to the Android or iPhone home screen. The installed app can scan QR codes directly. Camera controls include full-screen layouts, pinch zoom, lens switching, Eco Mode, and optional statistics. Manual focus, exposure, and flashlight availability depend on the device and browser.
- **Controller.** Change resolution, mute the feed microphone, identify displays, or link a vacant Browser Source. **Settings → Open in Browser** opens the shared dashboard. After first opening it from OBS, you can revisit the dashboard while OBS runs. [Local dashboard](http://127.0.0.1:48640/)
- **Migration.** Use **Settings → Export settings** and **Import settings** to move feeds, viewer links, and preferences. Transfer OBS scene collections separately and pair devices again on the new host.

## Build from source

**macOS.** Close OBS. Install the full OBS Studio 33.x build (33.0.1 or later), Go 1.25+, and Xcode Command Line Tools. Run the Terminal installer from the repository root.

```bash
bash scripts/build-install-macos.sh
```

Use `--build-only` to skip installation or set `OBS_APP` for a custom OBS location.

<details>
<summary>Windows build and network settings</summary>

**Build dependencies.** LLVM, Visual Studio x64 tools or xwin, Go 1.25+, OBS 33.0.1 source with obs-browser, the OBS Qt 6 SDK from obs-deps 2026-10-23, WiX 3.14.1, and LLVM-MinGW UCRT for the MSI prerequisite checker.

```powershell
.\scripts\build-windows.ps1 -ObsRoot 'C:\Program Files\obs-studio' -ObsSdk C:\src\obs-studio -BrowserSdk C:\src\obs-studio\plugins\obs-browser -QtSdk C:\tools\obs-qt6 -LlvmBin 'C:\Program Files\LLVM\bin'
.\scripts\package-windows.ps1 -Stage .\build\lan-lens -LlvmBin C:\tools\llvm-mingw\bin -WixBin C:\tools\wix -Output .\build\LAN-Lens-0.2.17-Windows-x64.msi
```

**Portable OBS.** Copy the built `lan-lens` folder into the portable OBS `plugins` directory. For a custom installed OBS path, pass `OBSROOT` to MSI setup.

**Network.** TCP 48640 serves the local dashboard, 48641 serves HTTPS pairing, and 48642 serves the certificate download. Media requires peer UDP connectivity. For custom HTTPS, use **Settings → Custom HTTPS certificate** with a PEM chain, matching private key, and a hostname that resolves to the OBS computer on the LAN.

</details>
