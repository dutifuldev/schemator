import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

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

export function resolvePath(path: string): string {
  return resolve(process.cwd(), path);
}

export function pathToFileNamePart(value: string): string {
  return `b64_${Buffer.from(value, "utf8").toString("base64url")}`;
}
