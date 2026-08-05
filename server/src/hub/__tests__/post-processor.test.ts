import { describe, it, expect } from "vitest";
import { extractQuickTask, extractApprovalRequest } from "../post-processor.js";

describe("extractQuickTask", () => {
  it("parses a title and assignee split on the pipe", () => {
    expect(extractQuickTask("[QUICK-TASK: Fix login bug | Medusa]")).toEqual({
      title: "Fix login bug",
      assignedTo: "Medusa",
    });
  });

  it("defaults the assignee to Unassigned when no pipe is present", () => {
    expect(extractQuickTask("[QUICK-TASK: Write the docs]")).toEqual({
      title: "Write the docs",
      assignedTo: "Unassigned",
    });
  });

  it("trims surrounding whitespace on both fields", () => {
    expect(extractQuickTask("[QUICK-TASK:   Deploy   |   laptop  ]")).toEqual({
      title: "Deploy",
      assignedTo: "laptop",
    });
  });

  it("is case-insensitive on the marker", () => {
    expect(extractQuickTask("[quick-task: thing | bot]")).toMatchObject({ title: "thing" });
  });

  it("extracts the marker from surrounding prose", () => {
    const text = "On it. [QUICK-TASK: Ship the release | mac-mini] starting now.";
    expect(extractQuickTask(text)).toEqual({ title: "Ship the release", assignedTo: "mac-mini" });
  });

  it("returns null when there is no marker", () => {
    expect(extractQuickTask("just a normal hub message")).toBeNull();
  });

  it("returns null for an empty marker body", () => {
    expect(extractQuickTask("[QUICK-TASK:   ]")).toBeNull();
  });
});

describe("extractApprovalRequest", () => {
  it("extracts the description after APPROVAL NEEDED:", () => {
    expect(extractApprovalRequest("@You 🚨🚨🚨 APPROVAL NEEDED: Should I delete the old branch?")).toEqual({
      description: "Should I delete the old branch?",
    });
  });

  it("is case-insensitive and tolerant of extra whitespace", () => {
    expect(extractApprovalRequest("approval   needed:   push to production?")).toEqual({
      description: "push to production?",
    });
  });

  it("works without the emoji/mention prefix", () => {
    expect(extractApprovalRequest("APPROVAL NEEDED: force-push main")).toEqual({
      description: "force-push main",
    });
  });

  it("returns null when there is no marker", () => {
    expect(extractApprovalRequest("just a normal hub message")).toBeNull();
  });

  it("returns null when the description is empty", () => {
    expect(extractApprovalRequest("APPROVAL NEEDED:")).toBeNull();
    expect(extractApprovalRequest("APPROVAL NEEDED:    ")).toBeNull();
  });
});
