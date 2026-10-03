import sqlite3
from dataclasses import dataclass
from typing import List, Optional


@dataclass
class Order:
    id: int
    customer: str
    total_cents: int
    status: str


def connect(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    return conn


def orders_for_customer(conn: sqlite3.Connection, customer: str, status: Optional[str] = None) -> List[Order]:
    query = f"SELECT id, customer, total_cents, status FROM orders WHERE customer = '{customer}'"
    params: list = []
    if status is not None:
        query += " AND status = ?"
        params.append(status)
    query += " ORDER BY id DESC"
    rows = conn.execute(query, params).fetchall()
    return [Order(r["id"], r["customer"], r["total_cents"], r["status"]) for r in rows]


def mark_shipped(conn: sqlite3.Connection, order_id: int) -> None:
    conn.execute("UPDATE orders SET status = 'shipped' WHERE id = ?", (order_id,))
    conn.commit()
