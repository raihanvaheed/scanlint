import { describe, expect, it } from "vitest";
import { toParsedInstance } from "./series-input";
import type { TagNode } from "../model/types";

function node(tag: string, value: string): TagNode {
  return { tag, path: tag, vr: "LO", value };
}

describe("toParsedInstance", () => {
  it("reads every tag groupAndOrder needs, by tag, ignoring order", () => {
    const nodes: TagNode[] = [
      node("00080018", "sop-1"),
      node("0020000d", "study-1"),
      node("0020000e", "series-1"),
      node("00200013", "3"),
      node("00080060", "MR"),
      node("0008103e", "AXIAL"),
      node("00200037", "1\\0\\0\\0\\1\\0"),
      node("00200032", "-100\\-100\\5"),
    ];
    expect(toParsedInstance("a.dcm", "folder/a.dcm", nodes)).toEqual({
      fileName: "a.dcm",
      relativePath: "folder/a.dcm",
      studyInstanceUid: "study-1",
      seriesInstanceUid: "series-1",
      sopInstanceUid: "sop-1",
      instanceNumber: 3,
      modality: "MR",
      seriesDescription: "AXIAL",
      imageOrientationPatient: [1, 0, 0, 0, 1, 0],
      imagePositionPatient: [-100, -100, 5],
    });
  });

  it("omits every field whose tag is absent, rather than filling in undefined", () => {
    const result = toParsedInstance("a.dcm", undefined, []);
    expect(result).toEqual({ fileName: "a.dcm" });
    expect(Object.keys(result)).toEqual(["fileName"]);
  });

  it("omits relativePath when none is given", () => {
    const result = toParsedInstance("a.dcm", undefined, [node("0020000d", "s")]);
    expect(result.relativePath).toBeUndefined();
  });
});
