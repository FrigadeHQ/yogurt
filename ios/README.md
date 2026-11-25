# Yogurt for iPhone

Yogurt on your iPhone works on its own: it records, writes the transcript and draft notes, searches and answers questions, all on the phone. If you also use Yogurt on your computer, the two connect over your Wi-Fi and stay in sync. Nothing goes through the internet.

There's no App Store version yet. You install it yourself from Xcode onto your own iPhone.

## What you need

- A Mac with **Xcode 26** or newer (free from the Mac App Store).
- An **iPhone on iOS 26** or newer, and its cable.
- An **Apple Account**. A free one works; apps installed with a free account stop opening after 7 days, and you run them again from Xcode to renew.
- For notes and Ask on the phone: an iPhone with **Apple Intelligence** turned on (Settings → Apple Intelligence & Siri). Without it, recording, transcripts and Search still work, and Ask works whenever your computer is nearby.

## Install it on your iPhone

1. **Sign in to Xcode.** Open Xcode, then Xcode → Settings → Accounts, click **+** and add your Apple Account.
2. **Plug in your iPhone** and unlock it. Tap **Trust** if it asks.
3. **Turn on Developer Mode** on the iPhone: Settings → Privacy & Security → Developer Mode → on. The iPhone restarts; confirm when it asks. (The option shows up after the iPhone has been plugged into Xcode once.)
4. **Open the project:** double-click `ios/Yogurt.xcodeproj` in this repository.
5. **Pick your team:** click **Yogurt** at the top of the file list, then the **Yogurt** target, then **Signing & Capabilities**. Under Team, choose `2JNSQVN3N8` if it's yours, otherwise your own name (Personal Team). If Xcode says the bundle identifier is taken, change `so.yogurt.ios` to something of your own, like `so.yogurt.ios.yourname`.
6. **Pick your iPhone** in the device menu at the top of the window.
7. Click **Run** (the play button, or Cmd-R). The first build takes a few minutes.
8. The first time, the iPhone won't open the app until you trust yourself as a developer: Settings → General → VPN & Device Management → your Apple Account → **Trust**. Then tap Yogurt.

## Connect it to Yogurt on your computer (optional)

On Mac, pairing is available in Settings. For development on Windows or Linux, start Yogurt with `YOGURT_PHONE=1`.

1. Open Yogurt on your computer.
2. In Yogurt on the computer, open **Settings → iPhone** and click **Pair a phone**. A 6-digit code shows.
3. On the iPhone, tap the status pill at the top of Home ("On this iPhone only"), or go to Settings → Connect to your computer.
4. Tap **Allow** when the iPhone asks to find devices on your network, pick your computer, and type the code.

Both need to be on the same Wi-Fi. Your meetings come over, and what you record on the iPhone goes to the computer, which writes the final notes.

If the iPhone stays on "Looking for computers…":

- **Mac:** System Settings → Privacy & Security → Local Network: turn on Yogurt (under `pnpm dev` it's listed as Electron, or as your terminal app).
- **Windows:** when Windows Firewall asks about Yogurt, allow it on private networks, and check that your Wi-Fi is set to Private.

## For developers

### YogurtKit tests

YogurtKit is the app's logic as a Swift package (storage, search, sync and its encryption, Ask, notes). Its tests run on the Mac, no iPhone needed:

```sh
cd ios/YogurtKit && swift test
```

### Building without signing

```sh
cd ios && xcodebuild -project Yogurt.xcodeproj -scheme Yogurt -sdk iphoneos CODE_SIGNING_ALLOWED=NO build
```

After adding or removing files, regenerate the project: `xcodegen --spec ios/project.yml`.

### Screenshots without opening the Simulator

A headless simulator plus the app's DEBUG launch arguments shows any screen without clicking:

```sh
xcodebuild -project ios/Yogurt.xcodeproj -scheme Yogurt -sdk iphonesimulator CODE_SIGNING_ALLOWED=NO -derivedDataPath /tmp/yogurt-sim build
UDID=$(xcrun simctl create yogurt-shots com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro com.apple.CoreSimulator.SimRuntime.iOS-26-4)
xcrun simctl boot $UDID && xcrun simctl bootstatus $UDID -b
xcrun simctl install $UDID /tmp/yogurt-sim/Build/Products/Debug-iphonesimulator/Yogurt.app
xcrun simctl ui $UDID appearance dark        # or light
xcrun simctl launch $UDID so.yogurt.ios -onboarded YES -sample YES -openAsk "What did we decide about pricing?"
sleep 5 && xcrun simctl io $UDID screenshot ask.png
xcrun simctl delete $UDID                    # when done (shut it down first)
```

Useful launch arguments (DEBUG builds only):

- `-onboarded YES|NO`, `-onboardingStep welcome|microphone|speech|computer|ready`
- `-sample YES`: sample meetings, acting as if connected to a computer
- `-previewStatus offline|syncing|searching|error`, `-previewComputer YES`
- `-openMeeting <id>` (with `-openAtMs <ms>`: the transcript at that moment), `-openTab summary|mine|transcript`
- `-openSearch <words>`, `-openAsk <question>` (empty: just the Ask screen), `-previewNoAppleIntelligence YES`
- `-openSettings YES`, `-openConnect YES`, `-openRecord YES -previewRecording YES`
