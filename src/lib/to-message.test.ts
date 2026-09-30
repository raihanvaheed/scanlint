import { describe, expect, it } from "vitest";
import { toMessage } from "./to-message";

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
