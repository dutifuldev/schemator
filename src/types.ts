export type ModelKind = "object" | "table" | "enum" | "array" | "scalar";

export type Decision =
  | "keep"
  | "rename"
  | "merge"
  | "derive"
  | "move"
  | "defer"
  | "remove"
  | "opaque";

export type Confidence = "low" | "medium" | "high";

export type SourceFile = {
  path: string;
  revision: string | null;
};

export type SourceSpan = {
  path: string;
  span: {
    startLine: number;
    endLine: number;
  };
};

export type FieldNode = {
  path: string;
  name: string;
  type: string;
  required: boolean;
  nullable: boolean;
  parent: string;
  objectLike: boolean;
  ref?: string;
  source: SourceSpan;
};

export type ModelNode = {
  id: string;
  kind: ModelKind;
  source: SourceSpan;
  fields: FieldNode[];
};

export type ModelGraph = {
  schemaVersion: 1;
  source: SourceFile;
  models: ModelNode[];
};

export type FieldReview = {
  schemaVersion: 1;
  model: string;
  fieldPath: string;
  decision: Decision;
  finalName: string;
  finalPath?: string;
  finalType: string;
  required: boolean;
  rationale: string;
  alternatives: string[];
  simplestChoice: string;
  confidence: Confidence;
  questions: string[];
  ownerBoundary?: string;
};

export type AggregateFinding = {
  severity: "error" | "warning" | "info";
  model?: string;
  fieldPath?: string;
  message: string;
};

export type AggregateReview = {
  schemaVersion: 1;
  ok: boolean;
  summary: Record<Decision | "totalFields", number>;
  decisions: FieldReview[];
  findings: AggregateFinding[];
};

export type ReviewOptions = {
  strategy: "lindy";
};

export type ExtractOptions = {
  sourcePath: string;
};
