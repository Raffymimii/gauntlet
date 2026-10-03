import sqlite3
from typing import List, Optional, Tuple

MAX_LIMIT = 100


def list_customers(
    conn: sqlite3.Connection, after_id: Optional[int] = None, limit: int = 20
) -> Tuple[List[sqlite3.Row], Optional[int]]:
    """One page of customers ordered by id, and the cursor for the next page (or None)."""
    limit = max(1, min(int(limit), MAX_LIMIT))
    cur = conn.cursor()
    cur.row_factory = sqlite3.Row
    if after_id is None:
        rows = cur.execute(
            "SELECT id, name, email FROM customers ORDER BY id LIMIT ?", (limit + 1,)
        ).fetchall()
    else:
        rows = cur.execute(
            "SELECT id, name, email FROM customers WHERE id > ? ORDER BY id LIMIT ?",
            (int(after_id), limit + 1),
        ).fetchall()
    has_more = len(rows) > limit
    page = rows[:limit]
    next_cursor = page[-1]["id"] if has_more else None
    return page, next_cursor
