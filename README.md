# Shop Device Control Panel (HandyFarm)

> **Legitimate-Use Notice**: All devices and accounts in this farm test applications developed and owned directly by our organization. No third-party platform account-farming, scraping, or terms-of-service circumvention is in scope or permitted. See [CONTEXT.md](file:///c:/Users/musta/Desktop/HandyFarm/CONTEXT.md) for detailed operational boundaries.

## Prerequisites
1. **Node.js** must be installed on this computer.
2. **scrcpy** must be installed and added to the Windows PATH (so that running `scrcpy` in the command prompt works from anywhere).

## How to Start the App

### Option A: Quick Launch (Development / Unpackaged Mode)
Use this if you just want to run the app right away without packaging it.
1. Double-click the `start-app.bat` file located in this folder.
2. A command prompt window will open and launch the app. Keep that window open while using the app.

### Option B: Final Packaged Version (For Daily Shop Use)
Use this to create a standalone executable (`.exe`) that doesn't require a terminal or Node.js to be running in the background. This is the recommended approach for daily shop staff use.

1. Double-click the `package-app.bat` file in this folder. 
2. Wait a minute or two while it builds the application.
3. Once complete, navigate to the newly created `release` folder in this directory.
4. You will find **Shop Device Control Panel Setup.exe**. 
5. Run that setup file to install the app on the computer like a normal Windows program. 
6. (Optional) You can now create a shortcut on your Desktop to the installed application, and shop staff will never have to touch a terminal again!

## Architecture Note: Embedded Live View Grid
This application natively embeds the Android screen mirroring functionality directly inside the UI, without launching external window processes.
- **Protocol & Decoding**: It uses the `@yume-chan/scrcpy` ecosystem and `@yume-chan/scrcpy-decoder-webcodecs` to deserialize and decode the H.264 video stream into a `<canvas>` element using hardware acceleration.
- **WebSocket Bridge**: The Electron main process spins up an ephemeral WebSocket server strictly bound to `127.0.0.1` to proxy raw video payloads and JSON touch commands safely.
- **Concurrency**: To prevent USB bandwidth starvation, a hard limit of `4` concurrent streams is enforced. Attempting to open more than 4 screens simultaneously will be blocked until another screen is closed.
- **Input Injection**: The `<canvas>` elements forward accurate boundary-mapped `PointerEvents` to the device as multi-touch Android `AMOTION_EVENT` inputs, creating a seamless remote control experience entirely within HandyFarm.
