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
  let fenceChar = "";
  let fenceLength = 0;
  let startLine = 0;
  let codeLines: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const openingFence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (openingFence && !inFence) {
      inFence = true;
      const fence = openingFence[1] ?? "";
      const info = openingFence[2]?.trim() ?? "";
      fenceChar = fence[0] ?? "";
      fenceLength = fence.length;
      language = info.split(/\s+/)[0]?.toLowerCase() ?? "";
      startLine = index + 2;
      codeLines = [];
      continue;
    }
    if (inFence && isClosingFence(line, fenceChar, fenceLength)) {
      blocks.push({
        language,
        code: codeLines.join("\n"),
        startLine,
        endLine: index,
      });
      inFence = false;
      language = "";
      fenceChar = "";
      fenceLength = 0;
      codeLines = [];
      continue;
    }
    if (inFence) {
      codeLines.push(line);
    }
  }

  return blocks;
}

function isClosingFence(line: string, fenceChar: string, fenceLength: number): boolean {
  const closingFence = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
  const fence = closingFence?.[1];
  return Boolean(fence && fence[0] === fenceChar && fence.length >= fenceLength);
}
