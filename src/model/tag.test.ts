import { describe, expect, it } from "vitest";
import {
  formatTag,
  isPrivateCreator,
  isPrivateTag,
  normalizeTag,
  tagElement,
  tagGroup,
} from "./tag";

describe("normalizeTag", () => {
  const forms = [
    "(0010,0010)",
    "0010,0010",
    "00100010",
    "x00100010",
    "0x00100010",
    "  (0010,0010)  ",
    "\t00100010\n",
    "X00100010",
    "0X00100010",
  ];

  it.each(forms)("accepts %j and returns 00100010", (input) => {
    expect(normalizeTag(input)).toBe("00100010");
  });

  it("returns lowercase for uppercase and mixed-case hex in every form", () => {
    for (const input of ["(00A1,00FF)", "00a1,00FF", "00A100ff", "x00A100Ff", "0X00a100FF"]) {
      expect(normalizeTag(input)).toBe("00a100ff");
    }
  });

  it("is idempotent", () => {
    expect(normalizeTag(normalizeTag("(7FE0,0010)"))).toBe("7fe00010");
  });

  const rejected = [
    "",
    "   ",
    "0010",
    "0010001",
    "001000100",
    "(0010,001)",
    "(0010,00100)",
    "(00100010)",
    "0010 0010",
    "( 0010 , 0010 )",
    "0x0010,0010",
    "x0010,0010",
    "(0010,0010",
    "0010,0010)",
    "zzzzzzzz",
    "0010,00G0",
    "0xx0100010",
    "#00100010",
  ];

  it.each(rejected)("rejects %j with a TypeError naming the input", (input) => {
    expect(() => normalizeTag(input)).toThrow(TypeError);
    expect(() => normalizeTag(input)).toThrow(input);
  });
});

describe("functions that take a normalised tag", () => {
  it("formatTag round-trips with normalizeTag", () => {
    expect(formatTag("00100010")).toBe("(0010,0010)");
    expect(formatTag("7fe00010")).toBe("(7FE0,0010)");
    for (const tag of ["00100010", "7fe00010", "04000561", "ffffffff"]) {
      expect(normalizeTag(formatTag(tag))).toBe(tag);
    }
  });

  it("tagGroup and tagElement split a tag into numbers", () => {
    expect(tagGroup("00100010")).toBe(0x0010);
    expect(tagElement("00100010")).toBe(0x0010);
    expect(tagGroup("7fe00010")).toBe(0x7fe0);
    expect(tagElement("00291001")).toBe(0x1001);
  });

  it("isPrivateTag is true for odd groups only", () => {
    expect(isPrivateTag("00291001")).toBe(true);
    expect(isPrivateTag("00100010")).toBe(false);
    expect(isPrivateTag("7fe00010")).toBe(false);
    expect(isPrivateTag("00090010")).toBe(true);
  });

  it("isPrivateCreator is true for elements 0010 to 00ff in an odd group", () => {
    expect(isPrivateCreator("00290010")).toBe(true);
    expect(isPrivateCreator("002900ff")).toBe(true);
    expect(isPrivateCreator("0029000f")).toBe(false);
    expect(isPrivateCreator("00290100")).toBe(false);
    expect(isPrivateCreator("00291001")).toBe(false);
    expect(isPrivateCreator("00100010")).toBe(false);
  });

  it("rejects a tag that has not been normalised, rather than normalising it", () => {
    const calls = [formatTag, tagGroup, tagElement, isPrivateTag, isPrivateCreator];
    for (const call of calls) {
      for (const input of ["(0010,0010)", "0010,0010", "x00100010", "00A10010", ""]) {
        expect(() => call(input)).toThrow(TypeError);
        expect(() => call(input)).toThrow(input);
      }
    }
  });
});
