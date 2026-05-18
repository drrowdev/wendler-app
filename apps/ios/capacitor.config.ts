import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.drrowdev.531',
  appName: 'Wendler 531',
  webDir: 'www',
  // WKWebView loads the deployed Static Web App directly. This means every
  // CI deploy to `main` is instantly live on the phone — no rebuild, no
  // resign, no TestFlight roll. The trade-off is the app needs network
  // on cold start; the SW + Dexie then handle offline once the shell is
  // cached. If you ever want true offline-on-cold-start, switch to a
  // bundled `webDir` build of `apps/web` and remove the `server.url`.
  server: {
    url: 'https://red-moss-02386a803.7.azurestaticapps.net',
    cleartext: false,
  },
  ios: {
    // Honor safe areas (notch, dynamic island, home indicator) automatically.
    contentInset: 'always',
    // Lock outbound navigation to the production domain so a compromised
    // link can't navigate the webview off-app.
    limitsNavigationsToAppBoundDomains: true,
    // Background color while the webview boots — match the app's dark theme
    // to avoid a white flash.
    backgroundColor: '#0a0a0a',
  },
};

export default config;
