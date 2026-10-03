from collections import defaultdict
from typing import Dict, List


def average_stock(levels: List[int]) -> float:
    return sum(levels) / len(levels)


def reorder_list(stock: Dict[str, List[int]], threshold: float) -> List[str]:
    out = []
    for sku, history in sorted(stock.items()):
        if average_stock(history) < threshold:
            out.append(sku)
    return out


def merge_counts(*counts: Dict[str, int]) -> Dict[str, int]:
    merged: Dict[str, int] = defaultdict(int)
    for c in counts:
        for sku, qty in c.items():
            merged[sku] += qty
    return dict(merged)
