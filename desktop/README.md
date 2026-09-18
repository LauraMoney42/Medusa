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

## Path resolution (no more entry.mjs hack)

`server/src/config.ts` used to derive `.env`, `uploadsDir`, and the served
client's `publicDir` purely from `__dirname` (via `import.meta.url`), which
broke once the server was compiled into a single `bun build --compile`
sidecar binary (every bundled module's `import.meta.url` collapses to the
same virtual bunfs path). That used to be worked around with a shim
entrypoint (`src-tauri/sidecar-src/entry.mjs`) that monkey-patched `fs` to
redirect the mis-resolved paths.

That shim is gone. Instead, `server/src/config.ts` reads three optional env
vars, falling back to the exact old `__dirname`-relative behavior when unset:

- `MEDUSA_ENV_FILE` - full path to the `.env` file (default: repo root).
- `MEDUSA_DATA_DIR` - directory holding `uploads/` and `default-bots.json`
  (default: server root).
- `MEDUSA_STATIC_DIR` - directory the built client is served from (default:
  `server/dist/public`).

`src-tauri/src/main.rs` sets all three before spawning the sidecar
(`MEDUSA_DATA_DIR`/`MEDUSA_ENV_FILE` point at a per-user Application Support
directory, `MEDUSA_STATIC_DIR` at the bundled `resources/public` resource),
so `desktop/scripts/build-sidecar.sh` now compiles `server/dist/index.js`
directly - no shim entrypoint needed.

## Subagent MCP shim

The same `import.meta.url` problem above also hit `server/src/mcp/descriptor.ts`'s
`resolveShimPath()`, which locates the compiled `medusa-mcp-shim.js` (the
stdio bridge every engine spawns to reach Medusa's subagent tools) the same
`__dirname`-relative way. Once the server was compiled into a single sidecar
binary, that path resolved inside the binary's own virtual filesystem - there
is no real `dist/mcp/medusa-mcp-shim.js` file on disk to hand `node` - so the
shim never started. The failure mode was worse than a missing feature: an
engine whose MCP server fails to connect (Kimi in particular) fails its
*entire* turn with "Failed to connect MCP servers", so the user saw no reply
at all.

The fix mirrors the server binary's own fix above: compile the shim too.
`desktop/scripts/build-sidecar.sh` runs a second `bun build --compile
--target=bun` on `server/dist/mcp/medusa-mcp-shim.js`, producing
`desktop/src-tauri/binaries/medusa-mcp-shim-<target-triple>`, registered in
`tauri.conf.json`'s `bundle.externalBin` next to `medusa-server`. In the
packaged app both binaries land side by side, with the triple suffix
stripped, in `Contents/MacOS/`.

`src-tauri/src/main.rs`'s `resolve_mcp_shim_path()` resolves that bundled
binary's real path the same way Tauri resolves `medusa-server` itself
(`Shell::sidecar("medusa-mcp-shim")`, converted to a `std::process::Command`
and read back with `.get_program()` - this never actually spawns anything, so
it needs no `shell:allow-*` capability grant) and passes it to the server
sidecar as `MEDUSA_MCP_SHIM_BIN`. `server/src/mcp/descriptor.ts` then runs
that binary directly (`command: <path>, args: []`) instead of `node <shim
path>` whenever it's set.

If the shim binary is missing for any reason (e.g. a `cargo run` dev build
with no sidecar build step), this degrades gracefully instead of breaking
chat: `server/src/mcp/config.ts` `descriptorForSession` checks the resolved
target actually exists before use, logs one warning, and returns null so
engines spawn without `--mcp-config` - subagent tools are unavailable for
that session, but the chat itself still works. The same warning reaches the
Activity Log as an `activity:event` of kind `"warning"`.

## Screen/window/region capture

Ported from `app/Sources/WindowPickerController.swift` /
`RegionPickerController.swift`. `src-tauri/src/main.rs` exposes a
`capture_screen(mode)` Tauri command that shells out to the macOS
`screencapture` CLI (`-x` full screen, `-i` region, `-i -w` window) and
returns the PNG as base64. `client/src/components/Input/captureScreen.ts`
tries `window.__TAURI__.core.invoke('capture_screen', ...)` first, falling
back to the legacy WKWebView `window.webkit.messageHandlers.captureScreen`
bridge, then `getDisplayMedia`, then a file picker - so the same
`captureScreenFrame`/`captureWindowFrame`/`captureRegionFrame` calls work
unchanged in both shells. This is a first pass (shelling out to
`screencapture` instead of a native `ScreenCaptureKit` overlay embedded in
the window); it's synchronous and blocks on the user's interactive
selection, which is adequate but not as polished as the Swift overlay.

## System tray, hotkey, notifications, auto-update

- **Tray**: Show / Hide / Quit menu. Closing the main window hides it to the
  tray instead of quitting (`WindowEvent::CloseRequested` calls
  `api.prevent_close()` unless the tray's Quit item was used); only Quit
  kills the sidecar and exits the process.
- **Global hotkey**: Cmd+Shift+M shows/focuses the window from anywhere,
  via `tauri-plugin-global-shortcut`.
- **Notifications**: `tauri-plugin-notification` is registered and permitted
  in `capabilities/default.json`. Note: `client/src` has no
  `new Notification(...)` call sites today to rewire - there's nothing yet
  on the client side that needs bridging to it.
- **Auto-update**: `tauri-plugin-updater` is registered with a placeholder
  endpoint/pubkey in `tauri.conf.json` (`bundle.updater`... see the `plugins.updater`
  block). To actually ship updates:
  1. Generate a signing keypair: `npx @tauri-apps/cli signer generate -w ~/.tauri/medusa.key`
     (writes a private key file and prints the public key).
  2. Put the printed public key in `tauri.conf.json`'s `plugins.updater.pubkey`.
  3. Replace `plugins.updater.endpoints` with your real update-manifest URL(s).
  4. Set `TAURI_SIGNING_PRIVATE_KEY` (and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
     if the key is password-protected) when running `tauri build` so it signs
     the bundle's update artifact.
  No real key was generated or committed as part of this work - the
  `pubkey`/`endpoints` in `tauri.conf.json` are placeholders.

## Entitlements

`src-tauri/Medusa.entitlements` ports `app/Resources/Medusa.entitlements`
verbatim (`com.apple.security.network.client/server`,
`com.apple.security.files.user-selected.read-write`,
`com.apple.security.files.downloads.read-write`,
`com.apple.security.cs.allow-unsigned-executable-memory`,
`com.apple.security.cs.disable-library-validation`) and is wired into
`tauri.conf.json`'s `bundle.macOS.entitlements`. Screen capture and
microphone access don't use entitlement keys on macOS - they're gated by
Info.plist usage-description strings plus a TCC prompt at runtime, so
`src-tauri/Info.plist` (merged into the bundle by `tauri-build` at build
time) carries `NSScreenCaptureUsageDescription` and
`NSMicrophoneUsageDescription`.

## Native folder picker (S9)

- [x] **`tauri-plugin-dialog`** registered in `src-tauri/Cargo.toml` /
      `src-tauri/src/main.rs` (`.plugin(tauri_plugin_dialog::init())`), with
      `dialog:allow-open` granted in `src-tauri/capabilities/default.json`.
      The client's New chat modal (`client/src/components/Sidebar/
      NewChatModal.tsx`) calls `window.__TAURI__.dialog.open({ directory:
      true, multiple: false, defaultPath })` when running under Tauri, and
      falls back to the plain text field (validated against
      `GET /api/files/stat`) in the browser build. The last 8 folders used
      are remembered in `localStorage` and shown as quick-pick chips.
- [x] **Folder chip in the chat header** (`client/src/components/Chat/
      ChatView.tsx`) opens the chat's working directory in Finder under
      Tauri, via `window.__TAURI__.shell.open(path)` (granted by
      `shell:allow-open`, alongside the existing sidecar `shell:allow-execute`
      / `shell:allow-spawn` permissions). In the browser it copies the path
      to the clipboard instead, since there is no filesystem to open.
- [x] **`MEDUSA_DESKTOP=1`** is passed to the sidecar in `start_sidecar_and_navigate`
      so `server/src/config.ts` can expose `config.isDesktop` for future
      desktop-only branching. No behavior change today.

## Still needs porting from the Swift shell

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
- [ ] **Native ScreenCaptureKit overlay** - the current `capture_screen`
      command shells out to the `screencapture` CLI as a first pass; a
      polished window/region picker (matching the Swift overlays' UX) would
      use `ScreenCaptureKit` bindings directly instead.
