/**
 * commands/retrieve.ts
 * remx retrieve — retrieve memories by filter or semantic query
 *
 * Usage:
 *   remx retrieve --db <path> [--meta <path>] [--filter '<json>'] [--query "..."] [--limit 50] [--decay-weight 0.5]
 *
 * Filter mode (no --query): calls retrieve()
 * Semantic mode (with --query): loads embedder from meta.yaml, embeds query, calls retrieveSemantic()
 */
import { Command } from "commander";
import { retrieve, retrieveSemantic, type RetrieveFilter } from "../memory/memory";
import { MetaYamlModel } from "../core/schema";
import { createEmbedder } from "../core/embedder";
import { embedQueryWithEmbedder } from "../index";

export function makeRetrieveCommand(): Command {
  const cmd = new Command("retrieve");
  cmd.description("retrieve memories by filter or semantic query");
  cmd.requiredOption("--db <path>", "path to SQLite database");
  cmd.option("--meta <path>", "path to meta.yaml (for embedder config)");
  cmd.option(
    "--filter <json>",
    "JSON filter object, e.g. '{\"category\":\"demand\"}'"
  );
  cmd.option(
    "--query <text>",
    "semantic query text (requires --meta for embedder config)"
  );
  cmd.option("--limit <n>", "max results to return", "50");
  cmd.option(
    "--decay-weight <w>",
    "decay weight for semantic scoring (0.0–1.0)",
    "0.3"
  );

  cmd.action(async (opts) => {
    const { db, filter, query, limit, decayWeight } = opts;
    const limitNum = parseInt(limit, 10);
    const decayW = parseFloat(decayWeight);

    if (query) {
      // Semantic mode — load embedder from meta.yaml
      if (!opts.meta) {
        console.error("remx retrieve: --meta is required for semantic search (--query)");
        process.exit(1);
      }
      try {
        const meta = MetaYamlModel.load(opts.meta);
        if (!meta.embedder) {
          console.error("remx retrieve: embedder not configured in meta.yaml");
          process.exit(1);
        }
        const embedder = createEmbedder({
          provider: meta.embedder.provider,
          model: meta.embedder.model,
          baseUrl: meta.embedder.base_url,
          timeout: meta.embedder.timeout,
          apiKey: meta.embedder.api_key ?? undefined,
        });
        if (!embedder) {
          console.error("remx retrieve: failed to create embedder");
          process.exit(1);
        }
        const embedding = await embedQueryWithEmbedder(query, embedder);
        if (embedding.length === 0) {
          console.error("remx retrieve: failed to embed query (embedder returned empty vector)");
          process.exit(1);
        }
        const parsedFilter: RetrieveFilter = filter ? JSON.parse(filter) : {};
        const rows = await retrieveSemantic(
          db,
          embedding,
          meta,
          parsedFilter,
          true,
          limitNum,
          decayW
        );
        if (rows.length === 0) {
          console.log("(no results)");
        } else {
          console.log(JSON.stringify(rows, null, 2));
        }
      } catch (err) {
        console.error(`[remx] semantic retrieval error: ${err}`);
        process.exit(1);
      }
    } else {
      // Filter mode
      const parsedFilter: RetrieveFilter = filter ? JSON.parse(filter) : {};
      const rows = retrieve(db, parsedFilter, true, limitNum);
      if (rows.length === 0) {
        console.log("(no results)");
      } else {
        console.log(JSON.stringify(rows, null, 2));
      }
    }
  });

  return cmd;
}
