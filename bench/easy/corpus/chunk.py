from typing import Iterable, Iterator, List, TypeVar

T = TypeVar("T")


def chunked(items: Iterable[T], size: int) -> Iterator[List[T]]:
    if size <= 0:
        raise ValueError("size must be positive")
    batch: List[T] = []
    for item in items:
        batch.append(item)
        if len(batch) == size:
            yield batch
            batch = []
    if batch:
        yield batch


def flatten(batches: Iterable[Iterable[T]]) -> List[T]:
    return [item for batch in batches for item in batch]
