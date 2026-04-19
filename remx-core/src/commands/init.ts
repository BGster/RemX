/**
 * commands/init.ts
 * remx init — initialize/reset database from meta.yaml
 *
 * Usage:
 *   remx init --db <path> --meta <path> [--reset]
 */
import { Command } from "commander";
import { join } from "path";
import { initDb } from "../memory/memory";
import { MetaYamlModel } from "../core/schema";

export function makeInitCommand(): Command {
  const cmd = new Command("init");
  cmd.description("initialize or reset database schema from meta.yaml");
  cmd.requiredOption("--db <path>", "path to SQLite database");
  cmd.requiredOption("--meta <path>", "path to meta.yaml");
  cmd.option("--reset", "drop existing tables before init", false);

  cmd.action(async (opts) => {
    const { db, meta, reset } = opts;

    // Load meta.yaml to get vector dimensions
    let dimensions = 1024;
    try {
      const metaModel = MetaYamlModel.load(meta);
      dimensions = metaModel.vector.dimensions;
    } catch (err) {
      console.error(`[remx] warning: could not parse meta.yaml: ${err}`);
    }

    initDb(db, dimensions, reset);
    console.log(`[remx] database initialized: ${db} (dimensions=${dimensions})${reset ? " (reset)" : ""}`);
  });

  return cmd;
}
