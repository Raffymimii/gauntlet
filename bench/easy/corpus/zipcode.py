import re
from typing import Optional

ZIP_RE = re.compile(r"\d{5}")
STATES = {"CA", "NY", "TX", "WA", "FL", "IL"}


def normalize_zip(raw: str) -> Optional[str]:
    value = raw.strip()
    if not ZIP_RE.match(value):
        return None
    return value


def normalize_address(street: str, city: str, state: str, zip_code: str) -> dict:
    state = state.strip().upper()
    if state not in STATES:
        raise ValueError(f"unsupported state: {state}")
    zip_value = normalize_zip(zip_code)
    if zip_value is None:
        raise ValueError(f"invalid zip code: {zip_code}")
    return {
        "street": " ".join(street.split()),
        "city": city.strip().title(),
        "state": state,
        "zip": zip_value,
    }
