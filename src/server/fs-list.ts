import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FsEntry, FsListResponse } from '../shared/protocol.js';

export function listRoots(platform: NodeJS.Platform = process.platform): string[] {
  if (platform !== 'win32') return ['/'];
  const roots: string[] = [];
  for (let code = 'A'.charCodeAt(0); code <= 'Z'.charCodeAt(0); code++) {
    const root = `${String.fromCharCode(code)}:\\`;
    if (existsSync(root)) roots.push(root);
  }
  return roots;
}

async function isDirectory(dirent: import('node:fs').Dirent, fullPath: string): Promise<boolean> {
  if (dirent.isDirectory()) return true;
  if (!dirent.isSymbolicLink()) return false;
  // Windows' legacy junctions ('Application Data', 'Cookies') point at real folders but deny listing
  try {
    const dir = await fs.opendir(fullPath);
    await dir.close();
    return true;
  } catch {
    return false;
  }
}

export async function listDirectory(requested?: string): Promise<FsListResponse> {
  const dir = path.resolve(requested && requested.trim() ? requested : os.homedir());
  const dirents = await fs.readdir(dir, { withFileTypes: true });

  const dirs: FsEntry[] = [];
  for (const dirent of dirents) {
    if (dirent.name.startsWith('.')) continue;
    // $Recycle.Bin, $WinREAgent and friends are system folders nobody runs an agent in
    if (process.platform === 'win32' && dirent.name.startsWith('$')) continue;
    const fullPath = path.join(dir, dirent.name);
    if (await isDirectory(dirent, fullPath)) dirs.push({ name: dirent.name, path: fullPath });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  const parent = path.dirname(dir);
  return { path: dir, parent: parent === dir ? null : parent, dirs, roots: listRoots() };
}
