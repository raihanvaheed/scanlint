export type TagPath = string;

export type FindingKind = "annex-e" | "private" | "burned-in";

export type LengthEncoding = "defined" | "undefined";

export type TagNode = {
  tag: string;
  path: TagPath;
  vr: string;
  keyword?: string;
  value?: string;
  items?: TagNode[][];
  lengthEncoding?: LengthEncoding;
};

export type Finding = {
  path: TagPath;
  tag: string;
  keyword?: string;
  vr: string;
  kind: FindingKind;
  action?: string;
  value?: string;
  lengthEncoding?: LengthEncoding;
};
