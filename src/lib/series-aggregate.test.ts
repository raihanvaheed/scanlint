import { describe, expect, it } from "vitest";
import { aggregateIdentifyingFields, deriveFolderName } from "./series-aggregate";
import type { Finding } from "../model/types";
import type { FileResult } from "./parse-many";

function finding(overrides: Partial<Finding> & Pick<Finding, "path" | "tag">): Finding {
  return { vr: "LO", kind: "annex-e", ...overrides };
}

describe("aggregateIdentifyingFields", () => {
  it("reports a field present in every file as one value, present in all of them", () => {
    const files = [
      { fileName: "a", findings: [finding({ path: "p1", tag: "t1", value: "X" })] },
      { fileName: "b", findings: [finding({ path: "p1", tag: "t1", value: "X" })] },
    ];
    const [field] = aggregateIdentifyingFields(files);
    expect(field).toMatchObject({ path: "p1", tag: "t1", presentIn: 2, total: 2 });
    expect(field.values).toEqual([{ value: "X", vr: "LO", length: undefined, files: ["a", "b"] }]);
  });

  it("reports a field present in only some files, with the files it's missing from left out", () => {
    const files = [
      { fileName: "a", findings: [finding({ path: "p1", tag: "t1", value: "X" })] },
      { fileName: "b", findings: [] },
      { fileName: "c", findings: [] },
    ];
    const [field] = aggregateIdentifyingFields(files);
    expect(field.presentIn).toBe(1);
    expect(field.total).toBe(3);
    expect(field.values[0].files).toEqual(["a"]);
  });

  it("splits disagreeing values into separate buckets, each with its own file count", () => {
    const files = [
      { fileName: "a", findings: [finding({ path: "p1", tag: "t1", value: "X" })] },
      { fileName: "b", findings: [finding({ path: "p1", tag: "t1", value: "Y" })] },
      { fileName: "c", findings: [finding({ path: "p1", tag: "t1", value: "X" })] },
    ];
    const [field] = aggregateIdentifyingFields(files);
    expect(field.values).toHaveLength(2);
    const byValue = new Map(field.values.map((v) => [v.value, v.files]));
    expect(byValue.get("X")).toEqual(["a", "c"]);
    expect(byValue.get("Y")).toEqual(["b"]);
  });

  it("groups by canonical path, not by tag alone, so the same tag at two depths is two fields", () => {
    const files = [
      {
        fileName: "a",
        findings: [finding({ path: "00080090", tag: "00080090", value: "X" }), finding({ path: "seq/0/00080090", tag: "00080090", value: "Y" })],
      },
    ];
    const fields = aggregateIdentifyingFields(files);
    expect(fields.map((f) => f.path).sort()).toEqual(["00080090", "seq/0/00080090"]);
  });

  it("excludes burned-in findings, the same way Stage 1's findings list does", () => {
    const files = [{ fileName: "a", findings: [finding({ path: "p1", tag: "t1", kind: "burned-in", value: "YES" })] }];
    expect(aggregateIdentifyingFields(files)).toEqual([]);
  });

  it("includes private findings, carrying their kind through so the reader can tell why", () => {
    const files = [{ fileName: "a", findings: [finding({ path: "p1", tag: "00990010", kind: "private" })] }];
    const [field] = aggregateIdentifyingFields(files);
    expect(field.kind).toBe("private");
  });

  it("returns fields in a stable order, by path", () => {
    const files = [
      { fileName: "a", findings: [finding({ path: "zzz", tag: "t1", value: "X" }), finding({ path: "aaa", tag: "t2", value: "Y" })] },
    ];
    expect(aggregateIdentifyingFields(files).map((f) => f.path)).toEqual(["aaa", "zzz"]);
  });
});

describe("deriveFolderName", () => {
  const read = (relativePath?: string): FileResult => ({ name: "x", relativePath, outcome: { kind: "read", nodes: [], findings: [] } });

  it("returns the shared first path segment when every file came from one folder", () => {
    expect(deriveFolderName([read("study/a"), read("study/sub/b")])).toBe("study");
  });

  it("returns undefined for a plain multi-file selection with no relative paths at all", () => {
    expect(deriveFolderName([read(undefined), read(undefined)])).toBeUndefined();
  });

  it("returns undefined when files disagree on their root folder", () => {
    expect(deriveFolderName([read("a/x"), read("b/y")])).toBeUndefined();
  });

  it("returns undefined for an empty list", () => {
    expect(deriveFolderName([])).toBeUndefined();
  });
});
