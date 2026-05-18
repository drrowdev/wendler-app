# `@wendler/ios` — Native iOS shell

Capacitor wrapper around the deployed PWA. The WKWebView loads
`https://red-moss-02386a803.7.azurestaticapps.net` directly, so any
CI deploy to `main` reaches the phone instantly — no rebuild needed
for content / feature changes.

## When to rebuild the iOS app

Only when one of these changes:

- `apps/ios/capacitor.config.ts` (bundle ID, app name, webview policy)
- `apps/ios/package.json` (Capacitor / plugin versions)
- iOS-only native code (when added later — push notifications, etc.)

Everything else — every web feature, every snapshot fix, every chat
update — propagates without a rebuild.

## Distribution: AltStore sideload (default)

Free path, no Apple Developer Program needed.

### One-time setup

1. On Windows: install **iCloud + Apple Mobile Device Support** from
   `apple.com/icloud/setup` (do NOT use the Microsoft Store version —
   it omits the mobile device service).
2. Install **AltServer for Windows** from `altstore.io`.
3. On iPhone: connect to PC via USB, open AltServer tray menu →
   *Install AltStore* → pick the device. AltStore lands on the phone.
4. On iPhone → Settings → General → VPN & Device Management →
   trust the free-developer profile.

### Per-build install

1. Trigger the **Build iOS .ipa (unsigned)** workflow in GitHub Actions
   (`Actions` tab → `iOS build` → `Run workflow`).
2. When it completes (~6–10 min on the macOS runner), download the
   `wendler-ios-unsigned.ipa` artifact from the run.
3. Drop the `.ipa` into AltServer's tray icon → *Install* → pick your
   iPhone. AltServer re-signs with your free Apple ID and installs
   over local Wi-Fi.
4. AltStore auto-refreshes every ~6 days while both ends are on the
   same network and AltServer is running. If you travel for > 7 days,
   open AltStore on return and tap *Refresh* (~20 sec).

## Distribution: TestFlight (when you outgrow sideload)

`.github/workflows/ios-build.yml` includes a commented-out TestFlight
upload section. To switch:

1. Buy the Apple Developer Program ($99/yr) at `developer.apple.com`.
2. App Store Connect → create app record with bundle ID `com.drrowdev.531`.
3. Create an API key (App Store Connect → Users and Access → Keys).
4. Add three GitHub repo secrets:
   - `APPSTORE_API_KEY_ID`
   - `APPSTORE_API_ISSUER_ID`
   - `APPSTORE_API_PRIVATE_KEY` (full .p8 file contents)
5. Uncomment the `# --- TestFlight upload ---` block at the bottom of
   `ios-build.yml` and switch the build matrix `signed` flag to `true`.
6. Push. Future runs upload to TestFlight automatically.

## Why no `apps/ios/ios/` folder?

`npx cap add ios` generates the Xcode project (`ios/App/App.xcodeproj`,
Podfile, Info.plist, etc.) — but those files are macOS-bound and don't
need to live in version control. CI regenerates them fresh on every
build via `npx cap add ios`, then runs `pod install` + `xcodebuild`.
This keeps the repo OS-agnostic and avoids drift between local Mac
checkouts (when there are no local Macs).

If you ever add a local Mac to the workflow, generated files land in
`apps/ios/ios/` and you'd add that path to `.gitignore` (already done).
