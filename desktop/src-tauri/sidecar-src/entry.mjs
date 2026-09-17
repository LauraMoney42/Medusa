// entry.mjs -- sidecar compile entrypoint.
//
// This file lives in desktop/ (not server/) so build-sidecar.sh can compile
// the Node server into a single Tauri sidecar binary without editing
// server/ at all.
//
// Background: server/src/{config.ts,index.ts,sessions/store.ts} each derive
// __dirname from import.meta.url and resolve a handful of paths relative to
// it (envPath, uploadsDir, publicDir, default-bots.json). That's correct
// when running from server/dist/*.js on a real filesystem. But `bun build
// --compile` bundles every module into one embedded file and every
// module's import.meta.url collapses to that single virtual path
// (/$bunfs/root/<binary-name>), so every __dirname-relative resolution
// either stays inside the virtual bunfs mount or walks (via "..") onto the
// real filesystem -- typically the real "/" root, which is read-only. Both
// crash the server on startup (EROFS) before it can even open its health
// endpoint.
//
// bun's `--asset` embedding (tried first during development of this script)
// can embed the client's static build into the bunfs mount, but express's
// `send`/`serve-static` (used by express.static) reads embedded files via
// fs.open()/createReadStream() in a way that reproducibly 404s against the
// bunfs virtual filesystem -- reads work through plain fs.readFileSync, but
// not through the streaming path express actually uses. Rather than fight
// that, the client build ships as a real directory next to the sidecar
// binary (a Tauri bundle resource -- see desktop/src-tauri/tauri.conf.json
// bundle.resources and desktop/scripts/build-sidecar.sh), and this shim
// redirects the server's computed publicDir to that real directory.
//
// Rather than touch server/, we patch the shared `fs` module object (the
// same singleton every bundled file imports) so any path bun would
// otherwise resolve onto the real "/" or into the virtual bunfs mount gets
// redirected to a real, writable location: the bundled public/ directory
// for static assets, and a persistent per-user data directory for
// everything else (uploads, the auto-generated .env, etc).
import fs from "fs";
import path from "path";
import os from "os";

const realReaddirSync = fs.readdirSync;

const DATA_DIR =
  process.env.MEDUSA_SIDECAR_DATA_DIR ||
  path.join(os.homedir(), "Library", "Application Support", "Medusa", "server-data");
fs.mkdirSync(DATA_DIR, { recursive: true });

// Real, on-disk directory holding the built client (client/dist, copied to
// server/dist/public at build time -- see build-sidecar.sh). Passed in by
// desktop/src-tauri/src/main.rs, which resolves it as a Tauri bundle
// resource at runtime; falls back to the co-located server/dist/public for
// running this entry file directly (outside a compiled sidecar) in dev.
const PUBLIC_DIR =
  process.env.MEDUSA_SIDECAR_PUBLIC_DIR ||
  path.resolve(new URL("../../../server/dist/public", import.meta.url).pathname);

const BUNFS_PUBLIC_PREFIX = "/$bunfs/root/public";

/** Known paths that escape the bunfs mount entirely (via "../.." from an
 *  already-flattened __dirname) and land on the real filesystem root. */
const KNOWN_ROOT_ESCAPES = new Set(["/.env", "/default-bots.json"]);

function remap(p) {
  if (typeof p !== "string") return p;
  if (process.env.MEDUSA_SIDECAR_DEBUG_FS) console.error("[fs-shim]", p);

  if (KNOWN_ROOT_ESCAPES.has(p)) {
    return path.join(DATA_DIR, path.basename(p));
  }

  if (p === BUNFS_PUBLIC_PREFIX || p.startsWith(BUNFS_PUBLIC_PREFIX + "/")) {
    // server/src/index.ts's publicDir (client static assets). Redirect to
    // the real directory shipped alongside the sidecar binary -- see the
    // module doc comment above for why this isn't served straight out of
    // the bunfs embed.
    const rel = p.slice(BUNFS_PUBLIC_PREFIX.length);
    return rel ? path.join(PUBLIC_DIR, rel) : PUBLIC_DIR;
  }

  if (p.startsWith("/$bunfs/")) {
    // Any other bunfs-adjacent path is a mis-resolved __dirname-relative
    // path (uploadsDir, etc). Redirect it into the real data directory,
    // preserving whatever relative structure was intended.
    const rel = p.slice("/$bunfs/".length).replace(/^root\/?/, "");
    return rel ? path.join(DATA_DIR, rel) : DATA_DIR;
  }

  return p;
}

function wrapSync(name) {
  const orig = fs[name];
  if (typeof orig !== "function") return;
  fs[name] = (p, ...rest) => orig(remap(p), ...rest);
}

function wrapAsync(name) {
  const orig = fs.promises[name];
  if (typeof orig !== "function") return;
  fs.promises[name] = (p, ...rest) => orig(remap(p), ...rest);
}

// Node-style callback APIs: fs.fn(path, ...args, callback). The callback is
// always the last argument, and `path` is always first, so a generic
// (p, ...rest) => orig(remap(p), ...rest) wrapper works here too.
function wrapCallback(name) {
  const orig = fs[name];
  if (typeof orig !== "function") return;
  fs[name] = (p, ...rest) => orig(remap(p), ...rest);
}

[
  "existsSync",
  "mkdirSync",
  "writeFileSync",
  "readFileSync",
  "appendFileSync",
  "statSync",
  "lstatSync",
  "readdirSync",
  "unlinkSync",
  "rmSync",
  "rmdirSync",
  "openSync",
  "copyFileSync",
  "renameSync",
  "realpathSync",
  "accessSync",
  "createWriteStream",
  "createReadStream",
].forEach(wrapSync);

["mkdir", "writeFile", "readFile", "appendFile", "stat", "lstat", "readdir", "unlink", "rm", "rename", "copyFile", "access", "realpath"].forEach(
  wrapAsync
);

// express's `send`/`serve-static` (used by express.static) call the
// callback-style fs.stat/fs.access/fs.open/fs.readdir directly rather than
// fs.promises or the *Sync variants, so those need wrapping too.
["stat", "lstat", "access", "open", "readdir", "readFile", "realpath"].forEach(wrapCallback);

if (process.env.MEDUSA_SIDECAR_DEBUG_FS) {
  console.error("[fs-shim] DATA_DIR:", DATA_DIR);
  console.error("[fs-shim] PUBLIC_DIR:", PUBLIC_DIR);
  console.error("[fs-shim] bunfs root listing:", realReaddirSync("/$bunfs/root"));
}

await import("../../../server/dist/index.js");
