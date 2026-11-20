## Watch the demo here
[![Watch the demo](https://img.youtube.com/vi/1TNtRQI8cwU/maxresdefault.jpg)](https://www.youtube.com/watch?v=1TNtRQI8cwU)


## Support the project
[<img src="assets/kofi6.webp" alt="Support this project" width="200">](https://ko-fi.com/bitwraith21)

## LAN Lens for OBS

LAN Lens receives phone or browser cameras as OBS Browser Sources and can send the same feed to other local browser displays. Pair each device with an expiring QR code. The OBS module uses C and C++ with the OBS Browser panel and Qt dock APIs. A bundled Go process serves the dashboard and phone pages, issues QR codes, and relays WebRTC session descriptions over local HTTPS. Camera audio and video travel directly between WebRTC peers. There is no PHP, database, cloud service, external STUN/TURN server, or separate language runtime to install on Windows. OBS WebSocket is optional and has no role in the camera path, the thumbnail says unlimited, but the limit is 32✌️. 

## Windows x64

1. Install the full OBS Studio 33.x build, version 33.0.1 or later, and close OBS.
2. Run `LAN-Lens-0.2.17-Windows-x64.msi` with administrator approval. The MSI lists bitwraith21 as its manufacturer. This build is unsigned, so Windows may show an unknown publisher warning. Setup checks for running OBS processes, a compatible OBS install, Browser Source and its Chromium files, and the required Windows and Visual C++ runtime files.
3. Launch OBS and open **Docks → LAN Lens for OBS**. **Tools → LAN Lens for OBS** also shows the dock. Choose **Settings → Open in Browser** to open the same dashboard in your browser. Both views share feeds, settings and pairing codes. Open the browser from the dock once per browser profile. After that, you can revisit or bookmark http://127.0.0.1:48640/ while OBS is open. Select a scene and click **Add to OBS** on the feed you want. OBS creates or reuses an audio-enabled Browser Source. Studio Mode targets Preview. The feed card reports bound source names and scene references. Deleting a feed clears the binding while preserving the OBS scene items.

The MSI installs to `%ProgramData%\obs-studio\plugins\lan-lens`. It attempts to add a Windows Firewall rule restricted to the companion executable, TCP 48641, the private profile, and the local subnet. Custom OBS installs can pass `OBSROOT` to MSI setup. Portable OBS uses its own plugin folder, so for a portable installation copy the build output's `lan-lens` folder to `<portable OBS>\plugins\`.

## Pair a camera or display

1. Choose the correct **Pairing address** if the computer has multiple network adapters. Connect the other device to the same local network.
2. Download **LAN Lens Local CA**, transfer the public certificate to the other device, and trust it in the operating system or browser. On iPhone and iPad, installing the certificate profile and enabling full trust are separate steps. The dashboard lists the setup steps by platform.
3. Click **Pair camera** or **Pair display** and scan the QR code or type the short link. Each six-character code is good for one use and expires after five minutes. Tap **Start camera** and grant camera and microphone access on the camera device.

The camera and microphone stay off until you start them. Use the display and camera controls on each feed card. **Identify all** shows the feed name briefly on every connected display. Waiting and signal-loss messages appear in the top-left corner. Pairing address, certificates, and settings migration are under the dashboard’s **Settings** button. Camera selection, lens preference, portrait framing, local preview, and supported zoom and torch controls are available on the camera page. Pinch on the preview or use the full-width slider in **Zoom** to change the outgoing video. For cameras that offer coarse native zoom steps, LAN Lens uses smooth digital zoom from 1× to 4×. Choose an available rear lens in the lens picker. Double-tap the live preview or tap the switch icon beside the lens picker to switch front and rear. LAN Lens restores the last selected rear lens when you switch back. A phone browser may expose several physical lenses or a single combined rear camera. Phones that lack hardware zoom can use digital zoom when their browser supports canvas capture. The preview uses 60% of the phone viewport in the standard layout. Controls scroll below it in portrait and beside it in landscape. **Restart camera** is under **Resolution**. The aspect button cycles Portrait, Landscape cropped and Landscape. In full-screen portrait, the two rows are centered above the bottom edge. In landscape, the main toolbar is at the bottom and shortcuts run down the right side. They hide after three seconds while the camera is live. Tap the preview to bring them back. The settings icon opens the floating controls, where **Full-screen settings** adjusts their opacity. Eco Mode hides the phone’s local preview while the outgoing feed keeps running. Choose Auto, 360p, 540p, 720p, or 1080p on the phone. The capture label shows what the camera actually provides. LAN Lens caps the outgoing video independently of the OBS source layout. Auto starts at 540p and adjusts using connection and encoder load statistics. The controller’s Resolution accordion shows the decoded frame sizes reported by connected displays. When supported by the lens, the phone also offers manual focus and exposure. At 1× zoom, Portrait keeps the full camera frame in a tall orientation. If a browser returns a wide frame in Portrait, LAN Lens rotates the full frame by 90 degrees. Landscape and Landscape cropped output 16:9. The normal selection follows screen rotation. Landscape cropped holds its selection without changing screen orientation. A scan gets a clear message when the code was used or the feed already has an active camera. Stop or unpair the old camera before switching phones. Browsers may need to stay open and awake for continuous capture.

The dashboard listens on loopback TCP 48640. The pairing server uses TLS on TCP 48641. With the local certificate, **Settings → Phone certificate download** shows a QR and HTTP link on TCP 48642 to download the CA directly to the phone. Compare the fingerprint shown in OBS before installing. After installing the CA, use **Open camera over HTTPS** on the phone download page to open the correct camera address. Phones that trust the configured HTTPS certificate can skip this step. WebRTC additionally needs peer UDP connectivity on the LAN. Guest networks, VLANs that isolate devices, routing through the public internet, and VPNs can prevent direct media from connecting.

### Install the camera as a home-screen app

Open the camera link in Safari on iPhone or Chrome on Android and choose **Install app**. If the native prompt is available, the app opens it. Otherwise the button shows the browser menu and HTTPS instructions. On iPhone use **Share → Add to Home Screen → Open as Web App**. On Android use the browser’s **Install app** or **Add to Home screen** option if the button shows instructions. In the installed app, tap **Scan pairing QR** and point the camera at **Pair camera** in the OBS dock. **Use a pairing code instead** is available if camera scanning is unavailable. To switch feeds, stop capture and tap **Pair another feed**. The QR must use the same LAN Lens HTTPS address as the installed app. OBS must be running on the LAN to stream.

### Use a certificate the phones already trust

In the dashboard open **Settings → Custom HTTPS certificate**. Enter the DNS hostname, the full path to its PEM certificate chain, and the full path to the matching PEM private key. Configure LAN DNS so that hostname resolves to the OBS computer and allow TCP 48641 on the LAN. Apply the setting and generate new pairing links. To reload renewed certificate files, apply the setting again or restart OBS.

Installing a local CA on the OBS computer only changes trust on that computer. For phones to connect without installing a CA, use a certificate from an issuer they already trust. A public CA can issue for a domain name you control, while local DNS points that name to the host's private IP address. The plug-in still serves and pairs phones on the LAN. **Use local certificate** restores the built-in LAN certificate and IP-based pairing.

### Microphone and controller commands

The microphone button beside the flashlight mutes or unmutes the audio sent from that phone to LAN Lens. The feed card's **Feed controls** includes a matching button for remote mute and unmute. The phone shows when the host changes its microphone, and the dock reports whether the phone applied the command. Camera restart and resolution commands also report their results.

### Statistics

Open **Camera statistics** on the phone for camera FPS, send FPS, sent dimensions, bitrate, encoder limit, encode time, round-trip time, and packet loss. Values depend on the WebRTC statistics the browser reports. The phone loads and processes the optional statistics only when the panel is open.

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
.\scripts\package-windows.ps1 -Stage .\build\lan-lens -LlvmBin C:\tools\llvm-mingw\bin -WixBin C:\tools\wix -Output .\build\LAN-Lens-0.2.17-Windows-x64.msi
```

The OBS log reports plugin loading and Browser Source creation. The companion's startup errors are recorded under `plugin_config/lan-lens/service/server.log` in the OBS configuration directory.
