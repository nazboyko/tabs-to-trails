import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '../config.js';

const ID = /^[a-f0-9]{12}$/;

export function isWalkId(id: string): boolean {
  return ID.test(id);
}

export function walkDir(id: string): string {
  if (!isWalkId(id)) throw new Error('Bad walk id');
  return path.join(loadConfig().WALKS_DIR, id);
}

export function newId(): string {
  return crypto.randomBytes(6).toString('hex');
}

export function newToken(): string {
  return crypto.randomBytes(18).toString('base64url');
}

export async function readJson<T>(dir: string, name: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Write-then-rename, so a killed process never leaves half a JSON file. */
export async function writeJson(dir: string, name: string, data: unknown): Promise<void> {
  const file = path.join(dir, name);
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, file);
}

export async function writeFileAtomic(file: string, data: string | Buffer): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, file);
}

export async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

export function slugify(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return slug || 'walk';
}

export async function listWalkIds(): Promise<string[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(loadConfig().WALKS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isDirectory() && isWalkId(e.name)).map((e) => e.name);
}
