import random
import time
from typing import Callable, TypeVar

T = TypeVar("T")

MAX_ATTEMPTS = 5
BASE_DELAY = 0.2


class TransientError(Exception):
    pass


def with_retry(fn: Callable[[], T]) -> T:
    attempts = 0
    while True:
        try:
            return fn()
        except TransientError:
            attempts += 1
            delay = BASE_DELAY * (2 ** attempts) + random.uniform(0, 0.1)
            time.sleep(delay)
            continue
        if attempts >= MAX_ATTEMPTS:
            raise RuntimeError(f"gave up after {attempts} attempts")
