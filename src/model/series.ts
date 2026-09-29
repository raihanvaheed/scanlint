import { orientationsAgree, projectOntoNormal, sliceNormal } from "./geometry";
import type { Orientation, Vector3 } from "./geometry";

export type OrderedBy = "position" | "instance-number" | "filename";

/** Why an instance couldn't be grouped. Only ever set on an entry in `Grouping.ungrouped`. */
export type UngroupedReason = "missing-study" | "missing-series" | "missing-both";

export type Instance = {
  fileName: string;
  relativePath?: string;
  sopInstanceUid?: string;
  instanceNumber?: number;
  distance?: number;
  ungroupedReason?: UngroupedReason;
};

export type Series = {
  seriesInstanceUid?: string;
  modality?: string;
  description?: string;
  orderedBy: OrderedBy;
  orientationConsistent: boolean;
  instances: Instance[];
};

export type Study = {
  studyInstanceUid?: string;
  series: Series[];
};

export type Grouping = {
  studies: Study[];
  ungrouped: Instance[];
};

/**
 * One successfully-parsed file's tags, as read off its `TagNode`s by the caller. Callers pass one
 * entry per file that parsed; a skipped or failed file is never given to `groupAndOrder`, which
 * has no way to tell "excluded on purpose" from "never existed" and does not need to.
 */
export type ParsedInstance = {
  fileName: string;
  relativePath?: string;
  studyInstanceUid?: string;
  seriesInstanceUid?: string;
  sopInstanceUid?: string;
  instanceNumber?: number;
  modality?: string;
  seriesDescription?: string;
  imageOrientationPatient?: Orientation;
  imagePositionPatient?: Vector3;
};

function toInstance(file: ParsedInstance): Instance {
  const instance: Instance = { fileName: file.fileName };
  if (file.relativePath !== undefined) instance.relativePath = file.relativePath;
  if (file.sopInstanceUid !== undefined) instance.sopInstanceUid = file.sopInstanceUid;
  if (file.instanceNumber !== undefined) instance.instanceNumber = file.instanceNumber;
  return instance;
}

function byFileName(a: { fileName: string }, b: { fileName: string }): number {
  return a.fileName < b.fileName ? -1 : a.fileName > b.fileName ? 1 : 0;
}

// Every orientation present is compared against the first one found; two planes that are each
// within tolerance of a shared third plane are, for any real DICOM series, the same plane.
function checkOrientationConsistency(files: ParsedInstance[]): boolean {
  const orientations = files.map((f) => f.imageOrientationPatient).filter((o): o is Orientation => o !== undefined);
  if (orientations.length < 2) return true;
  const [first, ...rest] = orientations;
  return rest.every((o) => orientationsAgree(first, o));
}

function orderSeries(files: ParsedInstance[]): { orderedBy: OrderedBy; orientationConsistent: boolean; instances: Instance[] } {
  const orientationConsistent = checkOrientationConsistency(files);
  const everyHasGeometry = files.every((f) => f.imageOrientationPatient !== undefined && f.imagePositionPatient !== undefined);

  if (orientationConsistent && everyHasGeometry) {
    const normal = sliceNormal(files[0].imageOrientationPatient!);
    const withDistance = files.map((f) => ({
      file: f,
      distance: projectOntoNormal(f.imagePositionPatient!, normal),
    }));
    withDistance.sort((a, b) => a.distance - b.distance);
    return {
      orderedBy: "position",
      orientationConsistent,
      instances: withDistance.map(({ file, distance }) => ({ ...toInstance(file), distance })),
    };
  }

  if (files.every((f) => f.instanceNumber !== undefined)) {
    const sorted = [...files].sort((a, b) => a.instanceNumber! - b.instanceNumber!);
    return { orderedBy: "instance-number", orientationConsistent, instances: sorted.map(toInstance) };
  }

  const sorted = [...files].sort(byFileName);
  return { orderedBy: "filename", orientationConsistent, instances: sorted.map(toInstance) };
}

// The most frequent value, ties broken by the value itself rather than by which file happened to
// come first. That keeps this independent of the order files were supplied in, even for a series
// whose instances disagree (2.4's question, not this step's) - grouping is deterministic on the
// set of files given it, not on the order the caller happened to hand them over.
function mostCommon(values: string[]): string | undefined {
  if (values.length === 0) return undefined;
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort(([av, ac], [bv, bc]) => bc - ac || (av < bv ? -1 : av > bv ? 1 : 0))[0][0];
}

function seriesMetadata(files: ParsedInstance[]): { modality?: string; description?: string } {
  const meta: { modality?: string; description?: string } = {};
  const modality = mostCommon(files.map((f) => f.modality).filter((v): v is string => v !== undefined));
  const description = mostCommon(files.map((f) => f.seriesDescription).filter((v): v is string => v !== undefined));
  if (modality !== undefined) meta.modality = modality;
  if (description !== undefined) meta.description = description;
  return meta;
}

/** Groups by study, then series, then orders each series' instances. Deterministic: the same
 * input, in any internal iteration order, always produces studies and series sorted by their own
 * identifier, so the same folder always yields the same result. */
export function groupAndOrder(files: ParsedInstance[]): Grouping {
  const ungrouped: Instance[] = [];
  const byStudy = new Map<string, Map<string, ParsedInstance[]>>();

  for (const file of files) {
    if (file.studyInstanceUid === undefined || file.seriesInstanceUid === undefined) {
      const ungroupedReason: UngroupedReason =
        file.studyInstanceUid === undefined && file.seriesInstanceUid === undefined
          ? "missing-both"
          : file.studyInstanceUid === undefined
            ? "missing-study"
            : "missing-series";
      ungrouped.push({ ...toInstance(file), ungroupedReason });
      continue;
    }
    let bySeries = byStudy.get(file.studyInstanceUid);
    if (!bySeries) {
      bySeries = new Map();
      byStudy.set(file.studyInstanceUid, bySeries);
    }
    const list = bySeries.get(file.seriesInstanceUid) ?? [];
    list.push(file);
    bySeries.set(file.seriesInstanceUid, list);
  }

  const studies: Study[] = [...byStudy.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([studyInstanceUid, bySeries]) => ({
      studyInstanceUid,
      series: [...bySeries.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([seriesInstanceUid, seriesFiles]) => {
          const { orderedBy, orientationConsistent, instances } = orderSeries(seriesFiles);
          return { seriesInstanceUid, ...seriesMetadata(seriesFiles), orderedBy, orientationConsistent, instances };
        }),
    }));

  ungrouped.sort(byFileName);
  return { studies, ungrouped };
}
