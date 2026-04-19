import { join, dirname } from "path";
import { platform, arch } from "os";
import { existsSync } from "fs";
import Database from "better-sqlite3";

export const DEFAULT_DB = join(process.env.HOME ?? ".", ".openclaw", "memory", "main.sqlite");

// ─── Platform detection ────────────────────────────────────────────────────────

/** Map {platform}-{arch} to the corresponding sqlite-vec platform package name. */
function getVecPackageName(): string {
  const p = platform();
  const a = arch();

  if (p === "linux") {
    if (a === "x64")   return "sqlite-vec-linux-x64";
    if (a === "arm64") return "sqlite-vec-linux-arm64";
  }
  if (p === "darwin") {
    if (a === "x64")   return "sqlite-vec-darwin-x64";
    if (a === "arm64") return "sqlite-vec-darwin-arm64";
  }
  if (p === "win32") {
    if (a === "x64")   return "sqlite-vec-windows-x64";
  }
  return "";
}

/** Extension filename for the current platform. */
function getVecExtName(): string {
  return platform() === "win32" ? "vec0.dll" : "vec0.so";
}

// ─── Extension loader ─────────────────────────────────────────────────────────

/**
 * Auto-detect and load the sqlite-vec extension for the current platform.
 *
 * Strategy:
 * 1. Detect platform + arch → map to sqlite-vec-{platform}-{arch} package name
 * 2. Try require.resolve to find the .so/.dll path
 *    (works regardless of node_modules nesting level in workspaces)
 * 3. Fall back to searching relative to better-sqlite3 and this file
 *
 * Throws if the extension cannot be found for the current platform.
 */
export function findVecExtension(): string {
  const pkg = getVecPackageName();
  const ext = getVecExtName();

  if (!pkg) {
    throw new Error(
      `[RemX] sqlite-vec is not supported on platform "${platform()}" (arch: ${arch()}). ` +
      `Supported platforms: linux-x64, linux-arm64, darwin-x64, darwin-arm64, win32-x64.`
    );
  }

  // Primary strategy: require.resolve from the package itself
  try {
    return require.resolve(`${pkg}/${ext}`);
  } catch {
    // fall through to fallback search
  }

  // Fallback: search relative to known packages / this file
  const candidates: string[] = [];

  // Relative to better-sqlite3 (always available as a dep)
  try {
    const bsDir = dirname(require.resolve("better-sqlite3"));
    candidates.push(
      join(bsDir, "..", pkg, ext),
      join(bsDir, "..", "..", pkg, ext),
    );
  } catch {
    // better-sqlite3 path not resolvable — skip
  }

  // Relative to this file (works for both dev and installed)
  candidates.push(
    join(__dirname, "..", "..", "node_modules", pkg, ext),
    join(__dirname, "..", "..", "..", "node_modules", pkg, ext),
    join(__dirname, "..", "..", "..", "..", "node_modules", pkg, ext),
  );

  for (const p of candidates) {
    if (existsSync(p)) return p;
  }

  const hint: Record<string, string> = {
    linux:   "Run: npm install sqlite-vec-linux-x64",
    darwin:  "Run: npm install sqlite-vec-darwin-x64 (or sqlite-vec-darwin-arm64 on Apple Silicon)",
    win32:   "Run: npm install sqlite-vec-windows-x64",
  };
  const curPlatform = platform();
  throw new Error(
    `[RemX] sqlite-vec extension not found for platform "${curPlatform}" (arch: ${arch()}). ${hint[curPlatform] ?? ""}`
  );
}

// ─── Database connection ──────────────────────────────────────────────────────

export function getDb(dbPath?: string): Database.Database {
  const d = new Database(dbPath ?? DEFAULT_DB);
  d.pragma("journal_mode = WAL");
  d.pragma("foreign_keys = ON");
  const vecExt = findVecExtension();
  try {
    d.loadExtension(vecExt);
  } catch (e) {
    d.close();
    throw new Error(`[RemX] Failed to load sqlite-vec extension from "${vecExt}": ${(e as Error).message}`);
  }
  return d;
}
