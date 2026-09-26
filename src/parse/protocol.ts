import type { Finding, TagNode } from "../model/types";

export type ParseRequest = {
  id: number;
  bytes: ArrayBuffer;
};

export type ParseResult =
  | { id: number; ok: true; nodes: TagNode[]; findings: Finding[] }
  | { id: number; ok: false; message: string };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type ParseOutcome = DistributiveOmit<ParseResult, "id">;
