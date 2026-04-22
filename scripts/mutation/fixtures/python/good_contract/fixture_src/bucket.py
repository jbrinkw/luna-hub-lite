"""good_contract/src/bucket.py

Mirrors scripts/mutation/fixtures/good_contract.ts — small boundary
functions whose branches each produce a distinguishable output so a
rigorous unit test can kill virtually every mutmut mutation.

Avoid equivalent-mutation traps: each comparison returns a different
typed result at its boundary, so swapping `<` to `<=` (etc.) is
observable via the return value, not silently absorbed.
"""

from __future__ import annotations


def bucket(score: int, limit: int) -> str:
    """Bucket a non-negative score into one of three labels.

        score == 0         -> "zero"
        0 <  score < limit -> "low"
        score >= limit     -> "high"
    """
    if score == 0:
        return "zero"
    if score < limit:
        return "low"
    return "high"


def clamp_tagged(n: int, maximum: int) -> tuple[int, str]:
    """Clamp ``n`` into ``[0, maximum]`` and return a tag identifying
    which branch fired.

    Returning both value + tag means even boundary-equivalent numeric
    mutations (e.g., ``n > max`` -> ``n >= max`` where ``n == max``)
    differ in the tag, so a rigorous test can still kill them.
    """
    if maximum < 0:
        return 0, "neg-max"
    if n < 0:
        return 0, "neg-n"
    if n > maximum:
        return maximum, "over"
    return n, "ok"
