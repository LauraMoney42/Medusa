import { describe, it, expect } from "vitest";
import { BargeInDetector, BARGE_IN_DEFAULTS, resolveBargeInOptions } from "../barge-in.js";

const FRAME_MS = 20;

/** Feed `count` frames of `energy` and return every non-"inactive" result. */
function feed(detector: BargeInDetector, energy: number, count: number, frameMs = FRAME_MS) {
  const results = [];
  for (let i = 0; i < count; i++) {
    const r = detector.pushFrame(energy, frameMs);
    if (r.kind !== "inactive") results.push(r);
  }
  return results;
}

describe("resolveBargeInOptions", () => {
  it("defaults the barge-in threshold to 4x the base VAD threshold", () => {
    expect(BARGE_IN_DEFAULTS.bargeInEnergyThreshold).toBe(2000);
    expect(BARGE_IN_DEFAULTS.bargeInMinSpeechMs).toBe(300);
  });

  it("clamps silly values", () => {
    const resolved = resolveBargeInOptions({
      bargeInEnergyThreshold: -5,
      bargeInMinSpeechMs: -10,
      floorMultiplier: 0,
    });
    expect(resolved.bargeInEnergyThreshold).toBeGreaterThanOrEqual(1);
    expect(resolved.bargeInMinSpeechMs).toBe(0);
    expect(resolved.floorMultiplier).toBeGreaterThanOrEqual(1);
  });
});

describe("BargeInDetector", () => {
  it("is inert until activated", () => {
    const d = new BargeInDetector();
    d.beginOnset();
    const results = feed(d, 9000, 50);
    expect(results).toHaveLength(0);
  });

  it("does not fire for playback leakage in the 800-1500 energy band", () => {
    const d = new BargeInDetector();
    d.activate();
    d.beginOnset();
    const results = feed(d, 1200, 50); // 1000 ms, well below the 2000 default bar
    expect(results).toHaveLength(0);
    const ignored = d.endOnset();
    expect(ignored).toEqual({ energy: 1200, ms: 0 });
  });

  it("fires a barge-in once a loud energy is sustained past bargeInMinSpeechMs", () => {
    const d = new BargeInDetector();
    d.activate();
    d.beginOnset();
    const results = feed(d, 5000, 20); // 400 ms at 20 ms/frame
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ kind: "barging", energy: 5000, ms: 300 });
    // Already resolved as a real barge-in: endOnset reports nothing further.
    expect(d.endOnset()).toBeNull();
  });

  it("does not fire for a short loud click under the sustain bar", () => {
    const d = new BargeInDetector();
    d.activate();
    d.beginOnset();
    const results = feed(d, 6000, 3); // 60 ms: loud, but far short of 300 ms
    expect(results).toHaveLength(0);
    const ignored = d.endOnset();
    expect(ignored).toEqual({ energy: 6000, ms: 60 });
  });

  it("resets the sustain run on a dip, so flickering energy never accumulates", () => {
    const d = new BargeInDetector({ bargeInMinSpeechMs: 100 });
    d.activate();
    d.beginOnset();
    // 3 loud frames (60ms), one quiet frame, 3 more loud frames (60ms): the
    // longest unbroken run is 60 ms, never reaching the 100 ms bar.
    feed(d, 5000, 3);
    feed(d, 100, 1);
    const results = feed(d, 5000, 3);
    expect(results).toHaveLength(0);
    const ignored = d.endOnset();
    expect(ignored?.ms).toBe(60);
  });

  it("raises the threshold from the measured echo floor during the first playback window", () => {
    const d = new BargeInDetector({ floorMeasureMs: 500, floorMultiplier: 2 });
    d.activate();
    d.beginPlayback();
    // Sample the echo floor: 25 frames (500 ms) of a 1300-energy echo.
    for (let i = 0; i < 25; i++) d.pushFrame(1300, FRAME_MS);
    expect(d.currentThreshold).toBe(2600); // max(2000 default, 1300 * 2)

    // A burst that would have cleared the static 2000 bar no longer does.
    d.beginOnset();
    const belowAdaptive = feed(d, 2200, 20); // 400 ms
    expect(belowAdaptive).toHaveLength(0);

    // A louder, sustained burst still gets through.
    d.beginOnset();
    const aboveAdaptive = feed(d, 3000, 20);
    expect(aboveAdaptive).toHaveLength(1);
    expect(aboveAdaptive[0].kind).toBe("barging");
  });

  it("keeps the static default when the measured floor is quiet", () => {
    const d = new BargeInDetector();
    d.activate();
    d.beginPlayback();
    for (let i = 0; i < 25; i++) d.pushFrame(300, FRAME_MS); // quiet room
    expect(d.currentThreshold).toBe(BARGE_IN_DEFAULTS.bargeInEnergyThreshold);
  });

  it("disarms after the grace window elapses", async () => {
    const d = new BargeInDetector({ graceMs: 10 });
    d.activate();
    expect(d.isActive).toBe(true);
    d.deactivateAfterGrace();
    expect(d.isActive).toBe(true); // still armed during the grace window
    await new Promise((r) => setTimeout(r, 25));
    expect(d.isActive).toBe(false);
  });

  it("deactivate() is immediate and drops any in-flight onset", () => {
    const d = new BargeInDetector();
    d.activate();
    d.beginOnset();
    feed(d, 6000, 3);
    d.deactivate();
    expect(d.isActive).toBe(false);
    expect(d.endOnset()).toBeNull();
  });
});
