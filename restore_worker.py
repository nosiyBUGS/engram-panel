#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Restore one soft-deleted Engram observation.

The panel normally performs this update itself.  This helper exists for panels
running on an older Python whose SQLite cannot write Engram's FTS5 trigram
index.  It is started with a newer Python and receives JSON on stdin.
"""

import json
import sqlite3
import sys


def write_json(payload):
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def main():
    try:
        raw = sys.stdin.buffer.read().decode("utf-8")
        payload = json.loads(raw)
        db_path = payload["db"]
        observation_id = int(payload["id"])
        expected_project = payload["expected_project"]
    except Exception as exc:
        write_json({"ok": False, "error_type": type(exc).__name__, "error": str(exc)})
        return 1

    con = None
    try:
        con = sqlite3.connect(db_path, timeout=30, isolation_level=None)
        con.row_factory = sqlite3.Row
        con.execute("BEGIN IMMEDIATE")
        row = con.execute(
            "SELECT id, project, deleted_at, sync_id FROM observations WHERE id = ?",
            (observation_id,),
        ).fetchone()
        if row is None:
            con.execute("ROLLBACK")
            raise LookupError("observation not found")
        if row["deleted_at"] is None:
            con.execute("ROLLBACK")
            raise ValueError("observation is not in trash")
        if (row["project"] or "") != expected_project:
            con.execute("ROLLBACK")
            raise PermissionError("project mismatch")

        con.execute(
            "UPDATE observations SET deleted_at = NULL, updated_at = datetime('now') "
            "WHERE id = ? AND deleted_at IS NOT NULL",
            (observation_id,),
        )
        con.execute("COMMIT")

        enrolled = False
        try:
            enrolled = con.execute(
                "SELECT 1 FROM sync_enrolled_projects WHERE project = ? LIMIT 1",
                (expected_project,),
            ).fetchone() is not None
        except sqlite3.Error:
            pass

        write_json({
            "ok": True,
            "id": observation_id,
            "project": expected_project,
            "sync_id": row["sync_id"],
            "enrolled": enrolled,
        })
        return 0
    except Exception as exc:
        if con is not None:
            try:
                con.execute("ROLLBACK")
            except sqlite3.Error:
                pass
        write_json({"ok": False, "error_type": type(exc).__name__, "error": str(exc)})
        return 1
    finally:
        if con is not None:
            con.close()


if __name__ == "__main__":
    sys.exit(main())
