import { describe, it, expect, vi } from "vitest";
import type { Request, Response, NextFunction, RequestHandler } from "express";
import { onlySessionCreate } from "../session-create-gate.js";

function req(method: string, path: string): Request {
  return { method, path } as Request;
}

describe("onlySessionCreate", () => {
  it("runs the limiter for POST /", () => {
    const limiter = vi.fn() as unknown as RequestHandler;
    const gate = onlySessionCreate(limiter);
    const next = vi.fn() as unknown as NextFunction;
    gate(req("POST", "/"), {} as Response, next);
    expect(limiter).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
  });

  it("skips the limiter for GET / (listing sessions)", () => {
    const limiter = vi.fn() as unknown as RequestHandler;
    const gate = onlySessionCreate(limiter);
    const next = vi.fn() as unknown as NextFunction;
    gate(req("GET", "/"), {} as Response, next);
    expect(limiter).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("skips the limiter for PATCH /:id (rename, provider/model change)", () => {
    const limiter = vi.fn() as unknown as RequestHandler;
    const gate = onlySessionCreate(limiter);
    const next = vi.fn() as unknown as NextFunction;
    gate(req("PATCH", "/abc123"), {} as Response, next);
    expect(limiter).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("skips the limiter for DELETE /:id", () => {
    const limiter = vi.fn() as unknown as RequestHandler;
    const gate = onlySessionCreate(limiter);
    const next = vi.fn() as unknown as NextFunction;
    gate(req("DELETE", "/abc123"), {} as Response, next);
    expect(limiter).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("skips the limiter for PUT /reorder", () => {
    const limiter = vi.fn() as unknown as RequestHandler;
    const gate = onlySessionCreate(limiter);
    const next = vi.fn() as unknown as NextFunction;
    gate(req("PUT", "/reorder"), {} as Response, next);
    expect(limiter).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });
});
