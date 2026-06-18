export function joinFieldPath(parentPath: string, name: string): string {
  const segment = escapeFieldPathSegment(name);
  return parentPath ? `${parentPath}.${segment}` : segment;
}

export function parentFieldPath(path: string): string {
  const lastDot = path.lastIndexOf(".");
  return lastDot === -1 ? "" : path.slice(0, lastDot);
}

export function replaceLastFieldPathSegment(path: string, finalName: string): string {
  const parent = parentFieldPath(path);
  return joinFieldPath(parent, finalName);
}

export function escapeFieldPathSegment(segment: string): string {
  return segment
    .replace(/~/g, "~0")
    .replace(/\./g, "~1")
    .replace(/\[/g, "~2")
    .replace(/\]/g, "~3");
}
