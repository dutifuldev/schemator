import type { FieldNode, ModelGraph } from "./types.js";

export type FieldIdentity = {
  model: string;
  path: string;
};

export type ChangedField = {
  before: FieldSnapshot;
  after: FieldSnapshot;
  changes: Array<{
    property: "name" | "type" | "required" | "objectLike";
    before: string | boolean;
    after: string | boolean;
  }>;
};

export type FieldSnapshot = FieldIdentity & Pick<FieldNode, "name" | "type" | "required" | "objectLike">;

export type GraphDiff = {
  initialModels: number;
  finalModels: number;
  initialFields: number;
  finalFields: number;
  removed: FieldSnapshot[];
  added: FieldSnapshot[];
  changed: ChangedField[];
};

export function diffGraphs(initial: ModelGraph, final: ModelGraph): GraphDiff {
  const initialFields = flattenFields(initial);
  const finalFields = flattenFields(final);
  const initialByKey = new Map(initialFields.map((field) => [fieldKey(field), field]));
  const finalByKey = new Map(finalFields.map((field) => [fieldKey(field), field]));
  const removed = initialFields.filter((field) => !finalByKey.has(fieldKey(field)));
  const added = finalFields.filter((field) => !initialByKey.has(fieldKey(field)));
  const changed: ChangedField[] = [];
  for (const before of initialFields) {
    const after = finalByKey.get(fieldKey(before));
    if (!after) {
      continue;
    }
    const changes = fieldChanges(before, after);
    if (changes.length > 0) {
      changed.push({ before, after, changes });
    }
  }
  return {
    initialModels: initial.models.length,
    finalModels: final.models.length,
    initialFields: initialFields.length,
    finalFields: finalFields.length,
    removed,
    added,
    changed,
  };
}

export function renderGraphDiff(diff: GraphDiff): string {
  const lines: string[] = [];
  lines.push("# Schemator Graph Diff");
  lines.push("");
  lines.push(`- Initial models: ${diff.initialModels}`);
  lines.push(`- Final models: ${diff.finalModels}`);
  lines.push(`- Initial fields: ${diff.initialFields}`);
  lines.push(`- Final fields: ${diff.finalFields}`);
  lines.push(`- Removed or renamed from initial graph: ${diff.removed.length}`);
  lines.push(`- Added or renamed into final graph: ${diff.added.length}`);
  lines.push(`- Changed in place: ${diff.changed.length}`);
  lines.push("");
  appendFields(lines, "Removed Or Renamed From Initial Graph", diff.removed);
  appendFields(lines, "Added Or Renamed Into Final Graph", diff.added);
  appendChangedFields(lines, diff.changed);
  return `${lines.join("\n")}\n`;
}

function flattenFields(graph: ModelGraph): FieldSnapshot[] {
  return graph.models.flatMap((model) =>
    model.fields.map((field) => ({
      model: model.id,
      path: field.path,
      name: field.name,
      type: field.type,
      required: field.required,
      objectLike: field.objectLike,
    }))
  );
}

function fieldKey(field: FieldIdentity): string {
  return `${field.model}\u0000${field.path}`;
}

function fieldChanges(before: FieldSnapshot, after: FieldSnapshot): ChangedField["changes"] {
  const changes: ChangedField["changes"] = [];
  for (const property of ["name", "type", "required", "objectLike"] as const) {
    if (before[property] !== after[property]) {
      changes.push({
        property,
        before: before[property],
        after: after[property],
      });
    }
  }
  return changes;
}

function appendFields(lines: string[], heading: string, fields: FieldSnapshot[]): void {
  lines.push(`## ${heading}`);
  lines.push("");
  if (fields.length === 0) {
    lines.push("_None._");
    lines.push("");
    return;
  }
  lines.push("| Model | Field | Type |");
  lines.push("| --- | --- | --- |");
  for (const field of fields) {
    lines.push(`| \`${escapePipe(field.model)}\` | \`${escapePipe(field.path)}\` | \`${escapePipe(field.type)}\` |`);
  }
  lines.push("");
}

function appendChangedFields(lines: string[], fields: ChangedField[]): void {
  lines.push("## Changed In Place");
  lines.push("");
  if (fields.length === 0) {
    lines.push("_None._");
    lines.push("");
    return;
  }
  lines.push("| Model | Field | Changes |");
  lines.push("| --- | --- | --- |");
  for (const field of fields) {
    const changes = field.changes.map((change) =>
      `${change.property}: ${String(change.before)} -> ${String(change.after)}`
    ).join("; ");
    lines.push(`| \`${escapePipe(field.before.model)}\` | \`${escapePipe(field.before.path)}\` | ${escapePipe(changes)} |`);
  }
  lines.push("");
}

function escapePipe(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
