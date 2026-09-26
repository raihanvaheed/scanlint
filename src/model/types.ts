export type TagPath = string;

export type FindingKind = "annex-e" | "private" | "burned-in";

export type LengthEncoding = "defined" | "undefined";

export type TagNode = {
  tag: string;
  path: TagPath;
  vr: string;
  keyword?: string;
  name?: string;
  value?: string;
  length?: number;
  items?: TagNode[][];
  lengthEncoding?: LengthEncoding;
};

export type Finding = {
  path: TagPath;
  tag: string;
  keyword?: string;
  name?: string;
  vr: string;
  kind: FindingKind;
  action?: string;
  value?: string;
  length?: number;
  lengthEncoding?: LengthEncoding;
};
