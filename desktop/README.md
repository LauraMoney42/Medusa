# Medusa Desktop (Tauri)

This replaces the hand-rolled Swift/WKWebView shell in `app/` with a
[Tauri v2](https://v2.tauri.app/) app. Same client (`client/`), same server
(`server/`) - Tauri just supplies the native window and process management,
and ships on macOS today with Windows as a later target.

## How it fits together

- **Frontend**: `client/dist` (built by `npm run build` in `client/`). Tauri's
  `frontendDist` points at it (`../client/dist` from `desktop/`) so the
  bundler considers it the app's web assets, but at runtime the window
  actually loads the UI from the sidecar's own HTTP server (see below) -
  that's what lets the client's relative `fetch('/api/...')` calls and
  same-origin Socket.IO connection (`client/src/socket.ts`) work unmodified.
- **Backend**: `server/` compiled into a single sidecar binary (see
  `scripts/build-sidecar.sh` and `src-tauri/sidecar-src/entry.mjs`).
- **Shell**: `src-tauri/src/main.rs` picks a free port, spawns the sidecar,
  polls its health endpoint, then points the window at it.

## Prerequisites

- Node.js + npm (already required by the rest of this repo)
- Rust + Cargo, via [rustup](https://rustup.rs/): `rustup default stable`
- [Bun](https://bun.sh/install) (preferred for compiling the sidecar; falls
  back to `npx pkg` if not installed, though see the caveat in
  "Known limitations" below)
- `@tauri-apps/cli`, installed locally in `desktop/` (not global) via
  `npm install` in this directory

## Dev loop

```bash
cd desktop
npm install
bash scripts/build-sidecar.sh   # builds client + server, compiles the sidecar
npm run tauri dev
```

`tauri dev` rebuilds the Rust shell and reopens the window; it does **not**
rebuild the sidecar or the client automatically, so re-run
`build-sidecar.sh` after changing `server/` or `client/`.

## Production build

```bash
cd desktop
npm install
bash scripts/build-sidecar.sh   # produces src-tauri/binaries/medusa-server-<triple>
npm run tauri build             # or: cargo tauri build
```

This runs `beforeBuildCommand` (`npm run build --prefix ../client`) and
produces `src-tauri/target/release/bundle/macos/Medusa.app` and a `.dmg`.
Verified end-to-end on this machine: `open Medusa.app`, wait ~2s, `curl
http://127.0.0.1:<port>/api/health` returns `{"ok":true,...}` and the window
shows the real Medusa UI (login/onboarding, chat, sidebar - all working).

## How the sidecar handshake works

1. `src-tauri/src/main.rs` binds `127.0.0.1:0` to get a free port from the
   OS, then immediately releases it (same small race the old
   `ServerManager.swift` tolerated) and generates a random 32-byte hex auth
   token in Rust (matching the format `server/src/config.ts` would generate).
2. It creates the main window up front, pointed at `about:blank`, with an
   `initialization_script` that seeds `localStorage['auth-token']` on every
   page load in that window - mirroring what `WebViewController.swift` did
   for the WKWebView, but as an init script (runs before page JS) instead of
   a post-load `evaluateJavaScript`, since the token needs to be present
   before `client/src/socket.ts` runs on the *next* page.
3. It spawns the `medusa-server` sidecar via `tauri-plugin-shell`, passing
   `PORT`, `HOST=127.0.0.1`, and `AUTH_TOKEN` as real environment variables
   (not `.env` file values - `dotenv.config()` never overrides an
   already-set `process.env` entry, so this works regardless of what's in
   `server/.env`).
4. It polls `GET http://127.0.0.1:<port>/api/health` (raw `TcpStream`, no
   HTTP crate needed for a localhost health check) until it returns 200 or
   30 seconds elapse - the same timeout `ServerManager.swift`'s `pollHealth`
   used.
5. Once healthy, it calls `window.navigate()` to point the window at
   `http://127.0.0.1:<port>`. The init script from step 2 reruns and seeds
   the auth token before the client's own JS executes.
6. On window close (`WindowEvent::CloseRequested`) or app exit
   (`RunEvent::Exit`), the sidecar child process is killed.

## Known limitations / caveats

- **Compiling the sidecar isn't a clean `bun build --compile
  server/dist/index.js`.** This server is ESM and derives several paths
  (`.env` location, `uploadsDir`, `publicDir`, `default-bots.json`) from
  `import.meta.url` via `__dirname`. Bun's standalone `--compile` mode
  bundles every module into one embedded virtual file, so every module's
  `import.meta.url` collapses to the same path and those derived paths
  either land inside the embedded virtual filesystem or escape onto the
  real, read-only `/`. Both crash the server on startup. Since `server/`
  can't be edited, `src-tauri/sidecar-src/entry.mjs` is used as the actual
  compile entrypoint instead of `server/dist/index.js` directly: it patches
  the shared `fs` module to redirect those mis-resolved paths to (a) a real
  per-user data directory (`~/Library/Application Support/Medusa/server-data`
  by default, override with `MEDUSA_SIDECAR_DATA_DIR`) and (b) the real,
  on-disk client build shipped alongside the binary as a Tauri bundle
  resource (`resources/public`, passed in via `MEDUSA_SIDECAR_PUBLIC_DIR`),
  before dynamically importing the real server entry. See that file's header
  comment for the full story, including why the client's static assets are
  shipped as a real directory rather than embedded via bun's `--asset` flag
  (express's `send`/`serve-static` 404s against bun's embedded virtual
  filesystem even though plain `fs.readFileSync` can read the same embedded
  file).
- **`pkg` fallback is best-effort only.** `pkg` cannot load this server's
  ESM build at all (fails with `MODULE_NOT_FOUND` even after bundling to
  CJS with esbuild, in testing on this machine). Installing Bun
  (`curl https://bun.sh/install | bash` or see bun.sh/install) is strongly
  recommended; `build-sidecar.sh` prints a warning if it has to fall back.
- **Bundle identifier**: `tauri.conf.json` keeps `com.claudechat.app` (same
  as `app/Resources/Info.plist`) so macOS TCC permissions (screen recording,
  microphone) carry over for anyone migrating from the Swift app. `tauri
  build` warns that a `.app`-suffixed identifier is discouraged; left as-is
  deliberately for that continuity - change it if TCC continuity doesn't
  matter for your install.
- Windows packaging (`externalBin`/`resources` need a
  `medusa-server-x86_64-pc-windows-msvc.exe` sidecar and Windows-specific
  bundle config) is not implemented yet, only scaffolded for later - the
  `desktop/scripts/build-sidecar.sh` target-triple detection and
  `tauri.conf.json` structure are meant to extend to it without rework.

## Still needs porting from the Swift shell

The Swift app (`app/`) has a few features this scaffold does not yet cover:

- [ ] **Screen/window capture** (`app/Sources/WindowPickerController.swift`,
      SC5) - system-wide window picker overlay using `ScreenCaptureKit`,
      triggered from the web UI via a `medusaNativeCapture` custom event.
      Needs a Tauri command + a native overlay window (Tauri doesn't have a
      screen-capture API of its own on macOS).
- [ ] **Region capture** (`app/Sources/RegionPickerController.swift`, SC6) -
      drag-to-select region screenshot overlay, same `ScreenCaptureKit`
      dependency as the window picker.
- [ ] **Entitlements** (`app/Resources/Medusa.entitlements`) - the Swift app
      requests `com.apple.security.network.client/server`,
      `com.apple.security.files.user-selected.read-write`,
      `com.apple.security.files.downloads.read-write`, and (for running an
      unsigned/ad-hoc-signed sidecar during development)
      `com.apple.security.cs.allow-unsigned-executable-memory` /
      `com.apple.security.cs.disable-library-validation`. None of this is
      wired into `tauri.conf.json` yet (`bundle.macOS.entitlements` is
      `null`) - needed before hardened-runtime/notarized distribution.
- [ ] **Screen Recording / Microphone usage strings**
      (`app/Resources/Info.plist`'s `NSScreenCaptureUsageDescription` /
      `NSMicrophoneUsageDescription`) - not yet carried over into Tauri's
      generated `Info.plist`.
- [ ] **Auto-restart on server crash (exit code 75)** - `ServerManager.swift`
      treats sidecar exit code 75 as "please restart me" (triggered by
      `POST /api/health/restart`) and respawns + reloads the WebView.
      `src-tauri/src/main.rs`'s `CommandEvent::Terminated` handler currently
      just logs and stops; it does not respawn.
      Also does not free/re-pick a port or notify the window.
  - [ ] **Crash dialog with stderr tail** - the Swift app shows the last ~8KB
      of sidecar stderr in an error view on crash; the Rust shell currently
      only prints to stdout/stderr.
- [ ] **App menu bar** (`app/Sources/main.swift`'s `setupMainMenu()`) - Edit
      menu (needed for copy/paste in the webview), View > Reload, custom
      About panel wiring. Tauri provides menu APIs
      (`tauri::menu`) but none are configured yet.
