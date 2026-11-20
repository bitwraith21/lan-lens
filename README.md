# LAN Lens for OBS

LAN Lens receives phone or browser cameras as OBS Browser Sources and can send the same feed to other local browser displays. Pair each device with an expiring QR code. The OBS module uses C and C++ with the OBS Browser panel and Qt dock APIs. A bundled Go process serves the dashboard and phone pages, issues QR codes, and relays WebRTC session descriptions over local HTTPS. Camera audio and video travel directly between WebRTC peers. There is no PHP, database, cloud service, external STUN/TURN server, or separate language runtime to install on Windows. OBS WebSocket is optional and has no role in the camera path.

## Windows x64

1. Install the full OBS Studio 33.x build, version 33.0.1 or later, and close OBS.
2. Run `LAN-Lens-0.2.0-Windows-x64.msi` with administrator approval. The MSI is unsigned. Setup checks for running OBS processes, a compatible OBS install, Browser Source and its Chromium files, and the required Windows and Visual C++ runtime files.
3. Launch OBS and open **Docks → LAN Lens for OBS**. **Tools → LAN Lens for OBS** also shows the dock. Choose **Open in Browser** to open the same dashboard in your browser. Both views share feeds, settings and pairing codes. Select a scene and click **Add to OBS** on the feed you want. OBS creates an audio-enabled Browser Source.

The MSI installs to `%ProgramData%\obs-studio\plugins\lan-lens`. It attempts to add a Windows Firewall rule restricted to the companion executable, TCP 48641, the private profile, and the local subnet. Custom OBS installs can pass `OBSROOT` to MSI setup. Portable OBS uses its own plugin folder, so for a portable installation copy the build output's `lan-lens` folder to `<portable OBS>\plugins\`.

## Pair a camera or display

1. Choose the correct **Pairing address** if the computer has multiple network adapters. Connect the other device to the same local network.
2. Download **LAN Lens Local CA**, transfer the public certificate to the other device, and trust it in the operating system or browser. On iPhone and iPad, installing the certificate profile and enabling full trust are separate steps. The dashboard lists the setup steps by platform.
3. Click **Pair camera** or **Pair display** and scan the QR code. Each code is good for one use and expires after five minutes. Tap **Start camera** and grant camera and microphone access on the camera device.

The camera and microphone stay off until you start them. Camera rotation, display identification, client reload, and camera reset are under **Feed controls**. Camera selection, lens preference, portrait framing, local preview, and supported zoom and torch controls are available on the camera page. Pinch on the preview or use the zoom slider to change the outgoing video. Phones that lack hardware zoom can use digital zoom when their browser supports canvas capture. The preview and controls sit side by side in landscape. A scan gets a clear message when the code was used or the feed already has an active camera. Stop or unpair the old camera before switching phones. Browsers may need to stay open and awake for continuous capture.

The dashboard listens on loopback TCP 48640. The pairing server uses TLS on TCP 48641. WebRTC additionally needs peer UDP connectivity on the LAN. Guest networks, VLANs that isolate devices, routing through the public internet, and VPNs can prevent direct media from connecting.

## Move settings to another computer

In the dashboard, choose **Export settings**, save the JSON file using the native file picker, and wait for Windows Explorer or Finder to reveal the saved file. On the new OBS installation, select **Import settings** and choose that JSON. It carries the feed names and IDs, OBS viewer links, rotation, camera preferences, and preferred LAN address. If the original address is absent, LAN Lens chooses an available local address.

Existing OBS Browser Sources retain their feed links when you transfer the corresponding OBS scene collection separately. Protect exports as they contain the viewer keys. The TLS identity and active pairing credentials are specific to each host. Trust the new host's CA and scan new codes after migration. A physical camera's device ID is specific to that phone and browser.

## Build and install on macOS from Terminal

Close OBS. On the Mac, install OBS Studio 33.0.1 or a later 33.x version, Go 1.25 or later, and the Xcode Command Line Tools. Extract this source archive, open Terminal in its top-level directory, and run:

```bash
bash scripts/build-install-macos.sh
```

The script checks for dependencies and running OBS, fetches the OBS 33.0.1 headers, OBS Browser panel header and compatible Qt SDK when needed, then builds for the architectures supported by the installed OBS app. It ad hoc signs and installs the bundle to `~/Library/Application Support/obs-studio/plugins/lan-lens.plugin`. For a custom OBS app location, set `OBS_APP`. Use `--build-only` to skip installation. This release was prepared without a Mac for native testing.

## Rebuild on Windows

Use LLVM for the MSVC ABI, a Visual Studio x64 Developer PowerShell or a local xwin SDK, Go 1.25+, OBS Studio 33.0.1 source and its obs-browser submodule, the OBS Qt 6 SDK from obs-deps 2026-10-23, and WiX Toolset 3.14.1. The WiX preflight build also uses LLVM-MinGW UCRT. These are build tools. The user-facing MSI uses the Qt runtime included with OBS.

```powershell
.\scripts\build-windows.ps1 -ObsRoot 'C:\Program Files\obs-studio' -ObsSdk C:\src\obs-studio -BrowserSdk C:\src\obs-studio\plugins\obs-browser -QtSdk C:\tools\obs-qt6 -LlvmBin "C:\Program Files\LLVM\bin"
.\scripts\package-windows.ps1 -Stage .\build\lan-lens -LlvmBin C:\tools\llvm-mingw\bin -WixBin C:\tools\wix -Output .\build\LAN-Lens-0.2.0-Windows-x64.msi
```

The OBS log reports plugin loading and Browser Source creation. The companion's startup errors are recorded under `plugin_config/lan-lens/service/server.log` in the OBS configuration directory.
