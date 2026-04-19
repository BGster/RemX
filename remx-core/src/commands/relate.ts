/**
 * remx relate — topology relation management CLI
 *
 * Actions:
 *   nodes   List all nodes
 *   insert  Insert a new relation
 *   delete  Delete a relation by ID
 *   query   Query relations for a node
 *   graph   BFS traversal to get related nodes
 */
import { Command } from "commander";
import {
  listNodes,
  insertTriple,
  deleteRelation,
  queryRelations,
  getRelatedNodes,
  topologyAwareRecall,
  REL_TYPES_ARRAY,
  type RelType,
  type BaseResult,
} from "../index";

/** Read all available stdin data as a string. */
function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: string[] = [];
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
    process.stdin.on("end", () => resolve(chunks.join("")));
  });
}

export function makeRelateCommand(): Command {
  const cmd = new Command("relate");
  cmd.description("manage topology relations between memory nodes");

  // ─── nodes ────────────────────────────────────────────────────────────────
  cmd
    .command("nodes")
    .description("list all topology nodes")
    .requiredOption("--db <path>", "path to SQLite database")
    .option("--category <cat>", "filter by category")
    .option("--limit <n>", "max nodes to show", "50")
    .action(async (opts) => {
      const nodes = listNodes(opts.db);
      const filtered = opts.category ? nodes.filter((n) => n.category === opts.category) : nodes;
      const limit = parseInt(opts.limit, 10);
      const shown = filtered.slice(0, limit);
      for (const n of shown) {
        const preview = n.chunk.slice(0, 60).replace(/\n/g, " ");
        console.log(`${n.id} [${n.category}] ${preview}`);
      }
      console.log(`(${filtered.length} nodes total)`);
    });

  // ─── insert ────────────────────────────────────────────────────────────────
  cmd
    .command("insert")
    .description("insert a new topology relation")
    .requiredOption("--db <path>", "path to SQLite database")
    .requiredOption("--nodes <ids>", "comma-separated node IDs (min 2)")
    .requiredOption("--rel-type <type>", `relation type: ${REL_TYPES_ARRAY.join(", ")}`)
    .option(
      "--roles <roles>",
      "comma-separated roles (auto: cause for first, effect for rest)"
    )
    .option("--context <ctx>", "context label (NULL = global)", "global")
    .option("--description <text>", "optional relation description")
    .action(async (opts) => {
      const { db, nodes, relType, roles, context, description } = opts;

      if (!REL_TYPES_ARRAY.includes(relType as RelType)) {
        console.error(`invalid rel-type: ${relType}. Options: ${REL_TYPES_ARRAY.join(", ")}`);
        process.exit(1);
      }

      const nodeIds = nodes.split(",").map((n: string) => n.trim());
      if (nodeIds.length < 2) {
        console.error("need at least 2 node IDs");
        process.exit(1);
      }

      const roleList = roles
        ? roles.split(",").map((r: string) => r.trim())
        : ["cause", ...Array(nodeIds.length - 1).fill("effect")];

      const ctx = context === "global" || context === "null" ? null : context;

      const relId = insertTriple({
        dbPath: db,
        relType: relType as RelType,
        nodeIds,
        roles: roleList as any,
        context: ctx,
        description: description ?? undefined,
      });

      console.log(`rel_id=${relId}`);
    });

  // ─── delete ───────────────────────────────────────────────────────────────
  cmd
    .command("delete")
    .description("delete a relation by ID")
    .requiredOption("--db <path>", "path to SQLite database")
    .requiredOption("--rel-id <id>", "relation ID to delete")
    .action(async (opts) => {
      const id = parseInt(opts.relId, 10);
      if (isNaN(id)) {
        console.error(`invalid relation ID: ${opts.relId}`);
        process.exit(1);
      }
      deleteRelation(opts.db, id);
      console.log(`deleted relation ${id}`);
    });

  // ─── query ────────────────────────────────────────────────────────────────
  cmd
    .command("query")
    .description("query relations for a node")
    .requiredOption("--db <path>", "path to SQLite database")
    .requiredOption("--node-id <id>", "node ID to query")
    .option("--current-context <ctx>", "context for filtering (default: global)", "global")
    .action(async (opts) => {
      const ctx = opts.currentContext === "global" ? null : opts.currentContext;
      const rels = queryRelations(opts.db, opts.nodeId, ctx ?? undefined);
      console.log(JSON.stringify(rels, null, 2));
    });

  // ─── graph ────────────────────────────────────────────────────────────────
  cmd
    .command("graph")
    .description("BFS traversal to get related nodes")
    .requiredOption("--db <path>", "path to SQLite database")
    .requiredOption("--node-id <id>", "starting node ID")
    .option(
      "--current-context <ctx>",
      "context for filtering (default: global)",
      "global"
    )
    .option("--max-depth <n>", "max BFS depth", "2")
    .action(async (opts) => {
      const ctx = opts.currentContext === "global" ? null : opts.currentContext;
      const maxDepth = parseInt(opts.maxDepth, 10);
      const graph = getRelatedNodes(opts.db, opts.nodeId, ctx ?? undefined, maxDepth);
      console.log(JSON.stringify(graph, null, 2));
    });

  // ─── expand ───────────────────────────────────────────────────────────────
  cmd
    .command("expand")
    .description("expand base results via topology graph (reads JSON from stdin)")
    .requiredOption("--db <path>", "path to SQLite database")
    .option(
      "--current-context <ctx>",
      "context for filtering (default: global)",
      "global"
    )
    .option("--max-depth <n>", "max BFS depth", "2")
    .option("--max-additional <n>", "max additional results", "10")
    .option("--stdin", "read base results as JSON array from stdin", false)
    .action(async (opts) => {
      if (!opts.stdin) {
        console.error("remx relate expand: --stdin is required (pipe base results as JSON)");
        process.exit(1);
      }
      const raw = await readStdin();
      let baseResults: BaseResult[];
      try {
        baseResults = (JSON.parse(raw || "[]") as unknown) as BaseResult[];
      } catch {
        console.error("remx relate expand: invalid JSON from stdin");
        process.exit(1);
      }
      const ctx = opts.currentContext === "global" ? null : opts.currentContext;
      const expanded = topologyAwareRecall(baseResults, {
        dbPath: opts.db,
        currentContext: ctx,
        maxDepth: parseInt(opts.maxDepth, 10),
        maxAdditional: parseInt(opts.maxAdditional, 10),
      });
      console.log(JSON.stringify(expanded, null, 2));
    });

  return cmd;
}
