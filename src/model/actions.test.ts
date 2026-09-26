import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import annexE from "./annex-e.json";
import { ACTION_GLOSS } from "./actions";

describe("ACTION_GLOSS", () => {
  const used = new Set<string>();
  for (const entry of [...annexE.attributes, ...annexE.patterns]) {
    for (const action of Object.values(entry.actions)) if (action !== null) used.add(action);
  }

  it("has a gloss for every distinct action string in annex-e.json, in any column", () => {
    expect(used.size).toBeGreaterThan(5);
    expect([...used].filter((action) => !(action in ACTION_GLOSS)).sort()).toEqual([]);
  });

  it("includes Z/D, which the first draft of the table missed", () => {
    expect(used.has("Z/D")).toBe(true);
    expect(ACTION_GLOSS["Z/D"]).toBe("blank, or a dummy where the field cannot be empty");
  });

  it("keeps Z and Z/D readable as different rules", () => {
    expect(ACTION_GLOSS.Z).toBe("blank, or replace with a dummy");
    expect(ACTION_GLOSS["Z/D"]).not.toBe(ACTION_GLOSS.Z);
  });

  it("has a non-empty gloss for every key and no key that Annex E never uses except K and C", () => {
    for (const [action, gloss] of Object.entries(ACTION_GLOSS)) expect(gloss.trim(), action).not.toBe("");
    expect(Object.keys(ACTION_GLOSS).filter((k) => !used.has(k))).toEqual([]);
  });

  it("imports nothing", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "actions.ts"), "utf8");
    expect(source.split("\n").filter((line) => /^\s*import\b/.test(line))).toEqual([]);
  });
});
