import { describe, expect, it } from "vitest";
import { isBinaryVr, splitVr } from "./vr";

describe("isBinaryVr", () => {
  it.each(["OB", "OW", "OF", "OD", "OL", "OV", "UN"])("is true for %s", (vr) => {
    expect(isBinaryVr(vr)).toBe(true);
  });

  it.each(["PN", "LO", "SQ", "US", "UL", "UI", "DA", "AT", "ob", ""])("is false for %j", (vr) => {
    expect(isBinaryVr(vr)).toBe(false);
  });
});

describe("splitVr", () => {
  it.each([
    ["US or SS", "US"],
    ["OB or OW", "OB"],
    ["SS or US", "SS"],
    ["US or SS or OW", "US"],
    ["US or OW", "US"],
  ])("takes the first VR of the compound %j", (compound, first) => {
    expect(splitVr(compound)).toBe(first);
  });

  it.each(["PN", "US", "SQ", "OB", "UN"])("passes the simple VR %s through", (vr) => {
    expect(splitVr(vr)).toBe(vr);
  });

  it("resolves every compound VR in the dictionary to a VR that is a single two-letter code", async () => {
    const { default: dictionary } = await import("./dictionary.json");
    // 34 attributes and 4 repeating patterns.
    const compounds = [...Object.values(dictionary.attributes), ...dictionary.patterns]
      .map((a): string | undefined => ("vr" in a ? String(a.vr) : undefined))
      .filter((vr): vr is string => vr !== undefined && vr.includes(" or "));
    expect(compounds.length).toBe(38);
    expect(compounds.map(splitVr).filter((vr) => !/^[A-Z]{2}$/.test(vr))).toEqual([]);
  });
});
