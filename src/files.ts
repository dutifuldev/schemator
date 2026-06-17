import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export async function readText(path: string): Promise<string> {
  return await readFile(path, "utf8");
}

export async function writeText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, "utf8");
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readText(path)) as unknown;
}

export async function prepareGeneratedOutputDir(path: string, generatedSuffix: string): Promise<void> {
  await mkdir(path, { recursive: true });
  const entries = await readdir(path, { withFileTypes: true });
  const unsafeEntries = entries
    .filter((entry) => !entry.isFile() || !entry.name.endsWith(generatedSuffix))
    .map((entry) => entry.name);
  if (unsafeEntries.length > 0) {
    throw new Error(
      `refusing to clear ${path}: contains non-generated entries (${unsafeEntries.join(", ")}). Use an empty dedicated output directory.`,
    );
  }
  await Promise.all(entries.map((entry) => rm(join(path, entry.name), { force: true })));
}

export function resolvePath(path: string): string {
  return resolve(process.cwd(), path);
}

export function pathToFileNamePart(value: string): string {
  const slug = value.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48) || "field";
  const hash = createHash("sha256").update(value).digest("hex").slice(0, 16);
  return `${slug}_${hash}`;
}
