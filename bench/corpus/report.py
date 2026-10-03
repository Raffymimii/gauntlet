import csv
from typing import Dict, Iterable, Iterator


def read_rows(path: str) -> Iterator[Dict[str, str]]:
    with open(path, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            yield row


def paid_rows(rows: Iterable[Dict[str, str]]) -> Iterator[Dict[str, str]]:
    return (r for r in rows if r.get("status") == "paid")


def summary(path: str) -> Dict[str, float]:
    rows = paid_rows(read_rows(path))
    count = sum(1 for _ in rows)
    revenue = sum(float(r["amount"]) for r in rows)
    average = revenue / count if count else 0.0
    return {"orders": count, "revenue": round(revenue, 2), "average": round(average, 2)}


def by_country(path: str) -> Dict[str, float]:
    totals: Dict[str, float] = {}
    for r in paid_rows(read_rows(path)):
        country = r.get("country") or "unknown"
        totals[country] = totals.get(country, 0.0) + float(r["amount"])
    return {k: round(v, 2) for k, v in sorted(totals.items())}
