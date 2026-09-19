import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Unit tests for `realCapture`, the thin wrapper around the actual
 * `screencapture` CLI invocation. `child_process` is mocked so no real
 * process is ever spawned here; the manual end-to-end check in CHANGELOG.md
 * covers the genuine `screencapture` call.
 */

const execFileMock = vi.fn();
vi.mock("child_process", () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

beforeEach(() => {
  execFileMock.mockReset();
});

describe("realCapture", () => {
  it("runs screencapture -x for fullscreen and resolves on success", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => cb(null));
    const { realCapture } = await import("../screenshot.js");

    await expect(realCapture("fullscreen", "/tmp/out.png")).resolves.toBeUndefined();
    expect(execFileMock).toHaveBeenCalledWith(
      "screencapture",
      ["-x", "/tmp/out.png"],
      expect.objectContaining({ timeout: 10_000 }),
      expect.any(Function)
    );
  });

  it("uses the interactive window-picker flags and a longer timeout", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => cb(null));
    const { realCapture } = await import("../screenshot.js");

    await realCapture("window", "/tmp/out.png");
    expect(execFileMock).toHaveBeenCalledWith(
      "screencapture",
      ["-i", "-w", "/tmp/out.png"],
      expect.objectContaining({ timeout: 30_000 }),
      expect.any(Function)
    );
  });

  it("uses the interactive region-select flag", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => cb(null));
    const { realCapture } = await import("../screenshot.js");

    await realCapture("region", "/tmp/out.png");
    expect(execFileMock).toHaveBeenCalledWith(
      "screencapture",
      ["-i", "/tmp/out.png"],
      expect.objectContaining({ timeout: 30_000 }),
      expect.any(Function)
    );
  });

  it("maps ENOENT to an 'unsupported' ScreenshotError", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      const err: NodeJS.ErrnoException = new Error("spawn screencapture ENOENT");
      err.code = "ENOENT";
      cb(err);
    });
    const { realCapture, ScreenshotError } = await import("../screenshot.js");

    await expect(realCapture("fullscreen", "/tmp/out.png")).rejects.toMatchObject({
      constructor: ScreenshotError,
      kind: "unsupported",
    });
  });

  it("maps a killed/timed-out process to a 'cancelled' ScreenshotError", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      const err = Object.assign(new Error("killed"), { killed: true });
      cb(err);
    });
    const { realCapture, ScreenshotError } = await import("../screenshot.js");

    await expect(realCapture("fullscreen", "/tmp/out.png")).rejects.toMatchObject({
      constructor: ScreenshotError,
      kind: "cancelled",
    });
  });

  it("maps any other failure to an 'unavailable' ScreenshotError", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(new Error("boom"));
    });
    const { realCapture, ScreenshotError } = await import("../screenshot.js");

    await expect(realCapture("fullscreen", "/tmp/out.png")).rejects.toMatchObject({
      constructor: ScreenshotError,
      kind: "unavailable",
    });
  });
});
