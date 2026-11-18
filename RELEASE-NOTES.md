# LAN Lens for OBS v0.2.1

**First public release.** LAN Lens brings a phone camera and microphone into OBS over your local network. Pair a phone with a QR code, then add its feed to an OBS scene as a Browser Source. The plugin runs its own local service and uses direct WebRTC for audio and video. It requires no cloud account, PHP server, database, or OBS WebSocket setup.

## Features

- **Built-in OBS dock** with a browser dashboard that shares the same feeds, settings, and pairing codes. Open the browser from the dock once per browser profile, then bookmark `http://127.0.0.1:48640/` for use while OBS is running.
- **QR pairing** for cameras and LAN displays. Codes expire after five minutes and work once. A second camera cannot interrupt a live feed.
- **Phone camera controls** with pinch-to-zoom on the outgoing video and layouts for portrait and landscape. Lens, torch, and hardware zoom availability depend on the device and browser.
- **Settings import and export** for moving feeds, viewer links, rotation, and camera preferences between computers.

## Downloads

- **Windows x64** — Download `LAN-Lens-0.2.1-Windows-x64.msi` from **Assets**. It requires the full OBS Studio 33.x build, version 33.0.1 or later. The MSI is unsigned and checks that OBS is closed and required components are present.
- **macOS** — Download `LAN-Lens-0.2.1-Source.zip` and follow the Terminal build and install instructions in its README. There’s no prebuilt macOS installer for this release.

## Quick start

1. Close OBS, install LAN Lens, and reopen OBS.
2. Open **Docks → LAN Lens for OBS**, select an OBS scene, and click **Add to OBS** beside your feed.
3. Connect your phone and OBS computer to the same local network. Download the LAN Lens trust certificate from the dock and follow the instructions there to trust it on your phone once.
4. Click **Pair camera**, scan the QR code, and tap **Start camera**. Allow camera and microphone access when prompted.

The dock, browser sync, QR pairing, and OBS audio and video were tested in portable OBS on Windows with a simulated phone. Physical-phone testing, a full MSI install and uninstall, and native macOS testing remain pending.
