import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { handleParse, toMessage } from "./handle";
import { flattenNodes } from "../model/tree";

const fixture = new Uint8Array(fs.readFileSync(path.resolve(__dirname, "../../public/samples/single.dcm")));

describe("handleParse on the fixture", () => {
  it("returns ok with the node and finding counts 1.3 and 1.4 established", () => {
    const outcome = handleParse(fixture);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.nodes.length).toBe(53);
    expect(flattenNodes(outcome.nodes).length).toBe(55);
    expect(outcome.findings.length).toBe(29);
  });

  it("returns plain data that survives structured cloning", () => {
    const outcome = handleParse(fixture);
    expect(structuredClone(outcome)).toEqual(outcome);
  });
});

describe("handleParse on bad input", () => {
  const notDicom: [string, Uint8Array][] = [
    ["ASCII text", new TextEncoder().encode("this is not a dicom file. ".repeat(40))],
    ["zeros", new Uint8Array(1000)],
    ["an empty buffer", new Uint8Array(0)],
  ];

  it.each(notDicom)("returns ok: false for %s, with a useful message", (_label, input) => {
    const outcome = handleParse(input);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(typeof outcome.message).toBe("string");
    expect(outcome.message.length).toBeGreaterThan(0);
    expect(outcome.message).not.toBe("undefined");
  });

  it("carries dicom-parser's own plain-string message through", () => {
    const outcome = handleParse(new Uint8Array(1000));
    expect(outcome).toEqual({ ok: false, message: expect.stringContaining("DICM prefix not found") });
  });

  it("handles a real Error thrown by the parser (a file with a Part 10 header and nothing else)", () => {
    const bytes = new Uint8Array(132);
    bytes.set(new TextEncoder().encode("DICM"), 128);
    const outcome = handleParse(bytes);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toContain("missing required meta header attribute");
  });
});

describe("toMessage", () => {
  it("returns a plain string as it is", () => {
    expect(toMessage("readPart10Header: DICM prefix not found")).toBe("readPart10Header: DICM prefix not found");
  });

  it("returns an Error's message", () => {
    expect(toMessage(new Error("boom"))).toBe("boom");
  });

  it("stringifies other values, and yields an empty string for undefined and null", () => {
    expect(toMessage(42)).toBe("42");
    expect(toMessage(undefined)).toBe("");
    expect(toMessage(null)).toBe("");
  });
});

describe("the fallback message", () => {
  afterEach(() => {
    vi.doUnmock("./walk");
    vi.resetModules();
  });

  it.each([
    ["an empty Error", () => new Error("")],
    ["an empty string", () => ""],
    ["undefined", () => undefined],
    ["null", () => null],
  ])("replaces the message when the parser throws %s", async (_label, makeThrown) => {
    vi.resetModules();
    vi.doMock("./walk", () => ({
      parseMetadata: () => {
        throw makeThrown();
      },
    }));
    const mocked = await import("./handle");
    expect(mocked.handleParse(fixture)).toEqual({ ok: false, message: "Could not read this file as DICOM." });
  });
});
