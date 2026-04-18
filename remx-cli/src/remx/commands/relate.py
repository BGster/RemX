"""remx relate command — manage memory topology relations."""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Optional

from ..core.topology import (
    DEFAULT_CONTEXT,
    REL_TYPES,
    delete_relation,
    get_related_nodes,
    insert_relation,
    list_nodes,
    query_relations,
    topology_aware_recall,
)


def run_relate(
    db_path: Path,
    action: str,
    *,
    node_id: Optional[str] = None,
    rel_type: Optional[str] = None,
    context: Optional[str] = None,
    description: Optional[str] = None,
    roles: Optional[str] = None,
    current_context: Optional[str] = None,
    max_depth: int = 2,
    max_additional: int = 10,
    limit: int = 50,
) -> int:
    """Manage topology relations between memory entries.

    Actions:
      insert    Insert a new relation
      delete    Delete a relation by ID
      query     Query relations for a node
      nodes     List all nodes (optionally filtered by category)
      graph     BFS traversal to get related nodes
      expand    Expand base semantic results via topology

    Returns:
        0 on success, 1 on error
    """
    if not db_path.exists():
        print(f"remx relate: {db_path}: database not found", file=sys.stderr)
        return 1

    try:
        if action == "nodes":
            nodes = list_nodes(db_path, category=None)
            for n in nodes[:limit]:
                print(f"{n['id']} [{n['category']}] {n['chunk'][:60]}")
            print(f"({len(nodes)} nodes total)", file=sys.stderr)
            return 0

        elif action == "insert":
            if not node_id:
                print("remx relate insert: --node-id required", file=sys.stderr)
                return 1
            if not rel_type:
                print("remx relate insert: --rel-type required", file=sys.stderr)
                return 1
            if rel_type not in REL_TYPES:
                print(f"remx relate insert: invalid rel_type. Options: {', '.join(REL_TYPES)}", file=sys.stderr)
                return 1

            # Parse roles if provided (comma-separated, must match node_id count)
            if roles:
                role_list = [r.strip() for r in roles.split(",")]
            else:
                # Default: first node is cause, rest are effects
                print("remx relate insert: --roles recommended (default: cause for first, effect for rest)", file=sys.stderr)
                role_list = []

            # For now, simplified: single bidirectional relation between two nodes
            # node_id format: id1,id2 (comma-separated)
            node_ids = [n.strip() for n in node_id.split(",")]
            if len(node_ids) < 2:
                print("remx relate insert: need at least 2 node IDs (comma-separated)", file=sys.stderr)
                return 1

            if not role_list:
                role_list = ["cause"] + ["effect"] * (len(node_ids) - 1)

            rel_id = insert_relation(
                db_path=db_path,
                rel_type=rel_type,
                node_ids=node_ids,
                roles=role_list,
                context=context,
                description=description,
            )
            print(f"rel_id={rel_id}")
            return 0

        elif action == "delete":
            if not node_id:
                print("remx relate delete: --node-id required (pass relation ID as integer)", file=sys.stderr)
                return 1
            try:
                rel_id = int(node_id)
            except ValueError:
                print(f"remx relate delete: relation ID must be integer, got: {node_id}", file=sys.stderr)
                return 1
            delete_relation(db_path, rel_id)
            print(f"deleted relation {rel_id}")
            return 0

        elif action == "query":
            if not node_id:
                print("remx relate query: --node-id required", file=sys.stderr)
                return 1
            rels = query_relations(db_path, node_id, current_context)
            print(json.dumps(rels, indent=2, ensure_ascii=False))
            return 0

        elif action == "graph":
            if not node_id:
                print("remx relate graph: --node-id required", file=sys.stderr)
                return 1
            graph = get_related_nodes(db_path, node_id, current_context, max_depth)
            print(json.dumps(graph, indent=2, ensure_ascii=False))
            return 0

        elif action == "expand":
            # For expand, we need base_results passed via stdin
            # base_results: list of entry dicts with at least 'id' field
            try:
                base_raw = sys.stdin.read()
                if not base_raw.strip():
                    base_results = []
                else:
                    base_results = json.loads(base_raw)
            except json.JSONDecodeError as e:
                print(f"remx relate expand: invalid JSON from stdin — {e}", file=sys.stderr)
                return 1

            expanded = topology_aware_recall(
                db_path=db_path,
                base_results=base_results,
                current_context=current_context,
                max_depth=max_depth,
                max_additional=max_additional,
            )
            print(json.dumps(expanded, indent=2, ensure_ascii=False))
            return 0

        else:
            print(f"remx relate: unknown action: {action}", file=sys.stderr)
            print(f"Actions: insert, delete, query, nodes, graph, expand", file=sys.stderr)
            return 1

    except Exception as e:
        print(f"remx relate: {action} error — {e}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        return 1
