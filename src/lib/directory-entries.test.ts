import { describe, expect, it } from "vitest";
import { collectEntries, extractEntries } from "./directory-entries";
import type { FileSystemDirectoryEntryLike, FileSystemEntryLike, FileSystemFileEntryLike } from "./directory-entries";

function fileEntry(name: string): FileSystemFileEntryLike {
  return {
    isFile: true,
    isDirectory: false,
    name,
    file: (success) => success(new File(["x"], name)),
  };
}

// Splits its children into two batches, so a walk that stops after the first `readEntries` call
// misses the second: exactly the bug the "call repeatedly until empty" rule guards against.
function dirEntry(name: string, children: FileSystemEntryLike[]): FileSystemDirectoryEntryLike {
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => {
      const batches = children.length > 0 ? [children.slice(0, 1), children.slice(1), []] : [[]];
      let i = 0;
      return {
        readEntries: (success) => success(batches[Math.min(i++, batches.length - 1)]),
      };
    },
  };
}

describe("collectEntries", () => {
  it("returns a single top-level file with its own name as the path", async () => {
    const result = await collectEntries([fileEntry("IM_0001")]);
    expect(result).toEqual([{ file: expect.any(File), relativePath: "IM_0001" }]);
  });

  it("walks a directory recursively, across more than one readEntries batch", async () => {
    const tree = dirEntry("series", [
      fileEntry("IM_0001"),
      dirEntry("nested", [fileEntry("IM_0002"), fileEntry("IM_0003")]),
      fileEntry("IM_0004"),
    ]);

    const result = await collectEntries([tree]);

    expect(result.map((f) => f.relativePath).sort()).toEqual([
      "series/IM_0001",
      "series/IM_0004",
      "series/nested/IM_0002",
      "series/nested/IM_0003",
    ]);
  });

  it("walks several top-level entries, mixing loose files and directories", async () => {
    const result = await collectEntries([fileEntry("README.txt"), dirEntry("A", [fileEntry("IM_0001")])]);
    expect(result.map((f) => f.relativePath).sort()).toEqual(["A/IM_0001", "README.txt"]);
  });

  it("returns nothing for an empty directory, and for no entries at all", async () => {
    expect(await collectEntries([dirEntry("empty", [])])).toEqual([]);
    expect(await collectEntries([])).toEqual([]);
  });

  it("rejects if a file entry's own read fails", async () => {
    const broken: FileSystemFileEntryLike = { isFile: true, isDirectory: false, name: "x", file: (_s, error) => error(new Error("denied")) };
    await expect(collectEntries([broken])).rejects.toThrow("denied");
  });
});

describe("extractEntries", () => {
  it("calls webkitGetAsEntry on every item and keeps only the results that exist", () => {
    const entry = fileEntry("IM_0001");
    const items = [{ webkitGetAsEntry: () => entry }, { webkitGetAsEntry: () => null }, { webkitGetAsEntry: undefined }];
    const list = { ...items, length: items.length } as unknown as DataTransferItemList;

    expect(extractEntries(list)).toEqual([entry]);
  });

  it("returns an empty list for an empty DataTransferItemList", () => {
    expect(extractEntries({ length: 0 } as unknown as DataTransferItemList)).toEqual([]);
  });
});
