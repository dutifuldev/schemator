export function joinFieldPath(parentPath: string, name: string): string {
  const segment = escapeFieldPathSegment(name);
  return parentPath ? `${parentPath}.${segment}` : segment;
}

export function escapeFieldPathSegment(segment: string): string {
  return segment
    .replace(/~/g, "~0")
    .replace(/\./g, "~1")
    .replace(/\[/g, "~2")
    .replace(/\]/g, "~3");
}
