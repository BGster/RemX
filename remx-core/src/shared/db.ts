import { join } from "path";
import Database from "better-sqlite3";
import { accessSync } from "fs";

export const DEFAULT_DB = join(process.env.HOME ?? ".", ".openclaw", "memory", "main.sqlite");

export function findVecExtension(): string | null {
  const candidates = [
    `${__dirname}/../../../node_modules/sqlite-vec-linux-x64/vec0.so`,
    `${__dirname}/../../node_modules/sqlite-vec-linux-x64/vec0.so`,
  ];
  for (const p of candidates) {
    try { accessSync(p); return p; } catch { /* skip */ }
  }
  return null;
}

export function getDb(dbPath?: string): Database.Database {
  const d = new Database(dbPath ?? DEFAULT_DB);
  d.pragma("journal_mode = WAL");
  d.pragma("foreign_keys = ON");
  const vecExt = findVecExtension();
  if (vecExt) {
    try { d.loadExtension(vecExt); } catch { /* vec0 unavailable */ }
  }
  return d;
}
