import { describe, expect, it } from "vitest";
import table from "./annex-e.json";
import {
  ANNEX_E_EDITION,
  basicProfileAction,
  lookupAnnexE,
  matchAnnexEPattern,
} from "./annex-e";

describe("extracted table", () => {
  it("has more than 500 attributes", () => {
    expect(table.attributes.length).toBeGreaterThan(500);
  });

  it("attribute and pattern counts match what the extraction recorded", () => {
    expect(table.attributes.length).toBe(table.source.attributeCount);
    expect(table.patterns.length).toBe(table.source.patternCount);
    expect(table.patterns.length).toBe(4);
  });

  it("has a non-empty edition", () => {
    expect(typeof ANNEX_E_EDITION).toBe("string");
    expect(ANNEX_E_EDITION.length).toBeGreaterThan(0);
    expect(ANNEX_E_EDITION).toBe(table.source.edition);
  });

  it("has basic plus ten option columns, and every entry has exactly those actions", () => {
    expect(table.columns[0]).toBe("basic");
    expect(table.columns.length).toBe(11);
    const expected = [...table.columns].sort();
    for (const entry of [...table.attributes, ...table.patterns]) {
      expect(Object.keys(entry.actions).sort()).toEqual(expected);
    }
  });

  it("every tag is 8 lowercase hex characters", () => {
    const bad = table.attributes.filter((a) => !/^[0-9a-f]{8}$/.test(a.tag));
    expect(bad.map((a) => a.tag)).toEqual([]);
  });

  it("has no duplicate tags", () => {
    const tags = table.attributes.map((a) => a.tag);
    expect(new Set(tags).size).toBe(tags.length);
  });

  it("is sorted by tag", () => {
    const tags = table.attributes.map((a) => a.tag);
    expect(tags).toEqual([...tags].sort());
  });

  it("every mask is 8 characters drawn from [0-9a-fx]", () => {
    const masks = table.patterns.flatMap((p) => (p.mask === undefined ? [] : [p.mask]));
    expect(masks.length).toBe(3);
    for (const mask of masks) {
      expect(mask).toMatch(/^[0-9a-fx]{8}$/);
    }
  });

  it("the Overlay Data pattern's mask is exactly 60xx3000", () => {
    const overlay = table.patterns.find((p) => p.tagPattern === "(60xx,3000)");
    expect(overlay?.name).toBe("Overlay Data");
    expect(overlay?.mask).toBe("60xx3000");
  });
});

describe("basicProfileAction", () => {
  it("returns the published action for exact entries", () => {
    expect(basicProfileAction("00100010")).toBe("Z");
    expect(basicProfileAction("00100020")).toBe("Z/D");
    expect(basicProfileAction("00080090")).toBe("Z");
  });

  it("returns undefined for a tag that is not in the table", () => {
    expect(basicProfileAction("00080060")).toBeUndefined();
  });

  it("uses a pattern when there is no exact entry", () => {
    expect(basicProfileAction("60003000")).toBe("X");
    expect(basicProfileAction("601e3000")).toBe("X");
    expect(basicProfileAction("50001000")).toBe("X");
  });

  it("gives private tags no action", () => {
    expect(basicProfileAction("00291001")).toBeUndefined();
  });

  it("does not treat a tag outside the mask as a match", () => {
    expect(basicProfileAction("61003000")).toBeUndefined();
    expect(basicProfileAction("60003001")).toBeUndefined();
  });

  it("rejects a tag that has not been normalised", () => {
    expect(() => basicProfileAction("(0010,0010)")).toThrow(TypeError);
  });
});

describe("lookupAnnexE and matchAnnexEPattern", () => {
  it("lookupAnnexE finds an exact entry and reports its details", () => {
    const entry = lookupAnnexE("00100010");
    expect(entry?.name).toBe("Patient's Name");
    expect(entry?.retired).toBe(false);
    expect(entry?.actions.basic).toBe("Z");
  });

  it("lookupAnnexE is exact-match only and never consults patterns", () => {
    expect(lookupAnnexE("60003000")).toBeUndefined();
  });

  it("matchAnnexEPattern finds nibbleMask patterns", () => {
    expect(matchAnnexEPattern("60003000")?.name).toBe("Overlay Data");
    expect(matchAnnexEPattern("601e3000")?.name).toBe("Overlay Data");
  });

  it("matchAnnexEPattern never matches the oddGroup pattern", () => {
    expect(matchAnnexEPattern("00291001")).toBeUndefined();
    expect(matchAnnexEPattern("00290010")).toBeUndefined();
  });

  it("both reject a tag that has not been normalised", () => {
    expect(() => lookupAnnexE("x00100010")).toThrow(TypeError);
    expect(() => matchAnnexEPattern("60xx3000")).toThrow(TypeError);
  });
});
