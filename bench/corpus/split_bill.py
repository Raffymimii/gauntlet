from decimal import Decimal, InvalidOperation, localcontext
from typing import List


def split_bill(total: str, people: int) -> List[Decimal]:
    """Split a bill into `people` shares that add up exactly to `total`.

    The total is given as a string ("123.45") so it never passes through a float. Shares
    differ by at most one cent; the extra cents go to the first shares.
    """
    if people < 1:
        raise ValueError("people must be at least 1")
    try:
        amount = Decimal(total)
    except InvalidOperation:
        raise ValueError(f"not a number: {total!r}") from None
    if not amount.is_finite() or amount < 0:
        raise ValueError("total must be a finite, non-negative amount")
    with localcontext() as ctx:
        # Enough digits for the whole amount, so nothing below is ever rounded.
        _, digits, exponent = amount.as_tuple()
        ctx.prec = len(digits) + max(0, exponent) + 10
        scaled = amount * 100
        if scaled != scaled.to_integral_value():
            raise ValueError("total must have at most two decimal places")
        base, extra = divmod(int(scaled), people)
        return [Decimal(base + (1 if i < extra else 0)) / 100 for i in range(people)]
