/**
 * commands/gc.ts
 * remx gc — garbage collection for expired/deprecated memories
 *
 * Usage:
 *   remx gc --db <path> [--scope-path <path>] [--dry-run] [--purge]
 *
 * --dry-run  : collect only (gcCollect), print report
 * --purge    : physically delete deprecated records (gcPurge)
 * default    : soft-delete expired + deprecated (gcSoftDelete)
 */
import { Command } from "commander";
import { gcCollect, gcSoftDelete, gcPurge } from "../memory/memory";

export function makeGcCommand(): Command {
  const cmd = new Command("gc");
  cmd.description("garbage collect expired/deprecated memories");
  cmd.requiredOption("--db <path>", "path to SQLite database");
  cmd.option("--scope-path <path>", "restrict GC to memories matching this file path prefix");
  cmd.option(
    "--dry-run",
    "collect only, report without deleting (equivalent to gcCollect)",
    false
  );
  cmd.option(
    "--purge",
    "physically delete all deprecated records (implies --dry-run=false)",
    false
  );

  cmd.action(async (opts) => {
    const { db, scopePath, dryRun, purge } = opts;

    if (purge) {
      // gcPurge: report + delete
      console.log(`[remx] running purge...`);
      const result = gcPurge(db);
      console.log(
        `[remx] purged: ${result.memories} memories, ${result.chunks} chunks removed`
      );
    } else if (dryRun) {
      // gcCollect: report only
      console.log(`[remx] running dry-run collect...`);
      const result = gcCollect(db, scopePath);
      console.log(`[remx] expired memories: ${result.expiredMemories.length}`);
      console.log(`[remx] deprecated memories: ${result.deprecatedMemories.length}`);
      console.log(`[remx] associated chunks: ${result.totalChunks}`);
      if (result.expiredMemories.length > 0) {
        console.log(`\nExpired memory IDs:`);
        for (const m of result.expiredMemories) {
          console.log(`  ${m["id"]} (category=${m["category"]}, expires_at=${m["expires_at"]})`);
        }
      }
      if (result.deprecatedMemories.length > 0) {
        console.log(`\nDeprecated memory IDs:`);
        for (const m of result.deprecatedMemories) {
          console.log(`  ${m["id"]} (category=${m["category"]})`);
        }
      }
    } else {
      // gcSoftDelete: soft-delete
      console.log(`[remx] running soft-delete...`);
      const result = gcSoftDelete(db, scopePath);
      console.log(
        `[remx] soft-deleted: ${result.expiredMemories} memories, ${result.chunks} chunks`
      );
    }
  });

  return cmd;
}
