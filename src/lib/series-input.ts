import type { Orientation, Vector3 } from "../model/geometry";
import type { ParsedInstance } from "../model/series";
import type { TagNode } from "../model/types";

const num = (raw: string | undefined): number[] => (raw ?? "").split("\\").map(Number);

/**
 * One successfully-parsed file's `ParsedInstance`, read off its top-level tag nodes. These tags are
 * never nested, so a plain lookup by tag is enough - the canonical-path comparisons 2.4's checks do
 * are a separate concern, over the findings, not this grouping input.
 */
export function toParsedInstance(fileName: string, relativePath: string | undefined, nodes: TagNode[]): ParsedInstance {
  const byTag = new Map(nodes.map((n) => [n.tag, n]));
  const value = (tag: string) => byTag.get(tag)?.value;

  const orientation = value("00200037");
  const position = value("00200032");
  const instanceNumber = value("00200013");

  const instance: ParsedInstance = { fileName };
  if (relativePath !== undefined) instance.relativePath = relativePath;
  if (value("0020000d") !== undefined) instance.studyInstanceUid = value("0020000d");
  if (value("0020000e") !== undefined) instance.seriesInstanceUid = value("0020000e");
  if (value("00080018") !== undefined) instance.sopInstanceUid = value("00080018");
  if (instanceNumber !== undefined) instance.instanceNumber = Number(instanceNumber);
  if (value("00080060") !== undefined) instance.modality = value("00080060");
  if (value("0008103e") !== undefined) instance.seriesDescription = value("0008103e");
  if (orientation !== undefined) instance.imageOrientationPatient = num(orientation) as unknown as Orientation;
  if (position !== undefined) instance.imagePositionPatient = num(position) as unknown as Vector3;
  return instance;
}
