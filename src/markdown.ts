export type MarkdownBlock = {
  language: string;
  code: string;
  startLine: number;
  endLine: number;
};

export function fencedCodeBlocks(text: string): MarkdownBlock[] {
  const lines = text.split(/\r?\n/);
  const blocks: MarkdownBlock[] = [];
  let inFence = false;
  let language = "";
  let startLine = 0;
  let codeLines: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const fence = /^ {0,3}```([A-Za-z0-9_-]*)(?:\s+.*)?$/.exec(line);
    if (fence && !inFence) {
      inFence = true;
      language = fence[1]?.toLowerCase() ?? "";
      startLine = index + 2;
      codeLines = [];
      continue;
    }
    if (/^ {0,3}```\s*$/.test(line) && inFence) {
      blocks.push({
        language,
        code: codeLines.join("\n"),
        startLine,
        endLine: index,
      });
      inFence = false;
      language = "";
      codeLines = [];
      continue;
    }
    if (inFence) {
      codeLines.push(line);
    }
  }

  return blocks;
}
