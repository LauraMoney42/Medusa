import { describe, expect, it } from "vitest";
import {
  endsWithSentencePunctuation,
  levenshtein,
  normalizeTranscript,
  normalizedDistance,
  shouldAbortSpeculation,
  SpeculationTracker,
} from "../speculation.js";

describe("transcript comparison", () => {
  it("normalizes case, punctuation and spacing", () => {
    expect(normalizeTranscript("  Hello,   THERE! ")).toBe("hello there");
  });

  it("measures edit distance", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
    expect(levenshtein("same", "same")).toBe(0);
    expect(levenshtein("", "abc")).toBe(3);
  });

  it("scores a punctuation-only difference as identical", () => {
    expect(normalizedDistance("what files are here", "What files are here?")).toBe(0);
  });
});

describe("shouldAbortSpeculation", () => {
  it("keeps a turn when the final transcript only tidied the wording", () => {
    expect(shouldAbortSpeculation("what files are in this folder", "What files are in this folder?")).toBe(
      false
    );
    // A single corrected word in a long sentence is well under the threshold.
    expect(
      shouldAbortSpeculation(
        "spawn an agent to count the typescript files",
        "spawn an agent to count the TypeScript files"
      )
    ).toBe(false);
  });

  it("restarts when the user actually said something else", () => {
    expect(shouldAbortSpeculation("what time is it", "cancel that and read the readme")).toBe(true);
    // The tail of a sentence the speculation cut off early counts as material.
    expect(shouldAbortSpeculation("delete the file", "delete the file, no wait, keep it")).toBe(true);
  });

  it("always restarts on an empty speculation", () => {
    expect(shouldAbortSpeculation("", "anything")).toBe(true);
    expect(shouldAbortSpeculation("   ", "anything")).toBe(true);
  });

  it("honors a custom threshold", () => {
    // At zero tolerance even a one-letter difference restarts the turn.
    expect(shouldAbortSpeculation("hello there", "hello thare", 0)).toBe(true);
    expect(shouldAbortSpeculation("hello there", "hello there", 0)).toBe(false);
    expect(shouldAbortSpeculation("hello there", "hello thare", 0.9)).toBe(false);
  });
});

describe("endsWithSentencePunctuation", () => {
  it("accepts terminators, including a closing quote", () => {
    expect(endsWithSentencePunctuation("is that right?")).toBe(true);
    expect(endsWithSentencePunctuation('she said "stop."')).toBe(true);
    expect(endsWithSentencePunctuation("go ")).toBe(false);
    expect(endsWithSentencePunctuation("and then")).toBe(false);
  });

  it("does not treat an ellipsis as the end of a thought", () => {
    // Whisper writes one whenever the audio stops mid-sentence, which every
    // partial window does.
    expect(endsWithSentencePunctuation("Tell me in two sentences...")).toBe(false);
    expect(endsWithSentencePunctuation("Tell me in two sentences…")).toBe(false);
  });
});

describe("SpeculationTracker with a truncated partial", () => {
  it("waits for the pause rather than firing on an ellipsis", () => {
    const t = new SpeculationTracker();
    t.onPartial("Tell me in two sentences...", 0);
    // Would have fired at 400 ms if the ellipsis counted as punctuation.
    expect(t.check(500)).toBeNull();
    expect(t.check(800)).toBeNull();
    // Only a second window saying the same thing confirms the pause.
    t.onPartial("Tell me in two sentences...", 700);
    expect(t.check(800)).toBe("Tell me in two sentences...");
  });
});

describe("SpeculationTracker", () => {
  it("fires once the punctuated hypothesis has been stable long enough", () => {
    const t = new SpeculationTracker();
    t.onPartial("what files are here?", 1000);
    expect(t.check(1200)).toBeNull(); // 200 ms, not stable yet
    expect(t.check(1400)).toBe("what files are here?");
    // Once per utterance only.
    expect(t.check(2000)).toBeNull();
    expect(t.started).toBe(true);
  });

  it("restarts the clock whenever the hypothesis changes", () => {
    const t = new SpeculationTracker();
    t.onPartial("what files?", 1000);
    t.onPartial("what files are here?", 1300);
    expect(t.check(1500)).toBeNull();
    expect(t.check(1700)).toBe("what files are here?");
  });

  it("waits longer when the hypothesis has no sentence punctuation", () => {
    const t = new SpeculationTracker();
    t.onPartial("open the readme", 0);
    expect(t.check(500)).toBeNull(); // past stableMs, but a pause is required
    // Still not enough: the same text has to come back a second time, or the
    // silence may just be the gap between two partial windows.
    expect(t.check(750)).toBeNull();
    t.onPartial("open the readme", 700);
    expect(t.check(750)).toBe("open the readme");
  });

  it("ignores a hypothesis too short to be a question", () => {
    const t = new SpeculationTracker();
    t.onPartial("uh.", 0);
    expect(t.check(5000)).toBeNull();
  });

  it("never fires when disabled", () => {
    const t = new SpeculationTracker({ enabled: false });
    t.onPartial("read the file.", 0);
    expect(t.check(5000)).toBeNull();
  });

  it("forgets everything on reset", () => {
    const t = new SpeculationTracker();
    t.onPartial("read the file.", 0);
    expect(t.check(500)).toBe("read the file.");
    t.reset();
    expect(t.started).toBe(false);
    expect(t.candidate).toBe("");
  });
});
