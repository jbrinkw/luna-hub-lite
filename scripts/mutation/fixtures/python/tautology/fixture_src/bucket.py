"""tautology/src/bucket.py

Same function shape as good_contract — only the test changes. This is
the NEGATIVE fixture: weak tests should leave most mutants surviving,
so mutmut reports LOW score (< 30%). Used by the mutation meta-test to
prove the gate discriminates.
"""

from __future__ import annotations


def bucket(score: int, limit: int) -> str:
    if score == 0:
        return "zero"
    if score < limit:
        return "low"
    return "high"


def clamp_tagged(n: int, maximum: int) -> tuple[int, str]:
    if maximum < 0:
        return 0, "neg-max"
    if n < 0:
        return 0, "neg-n"
    if n > maximum:
        return maximum, "over"
    return n, "ok"
