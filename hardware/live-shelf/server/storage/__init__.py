"""Storage layer for the Live Shelf demo.

Public surface:
    init_db(path)              -> sqlite3.Connection (applies migrations)
    apply_migrations(conn)     -> bool
    repo.*                     -> CRUD functions per table
    models.*                   -> Pydantic dataclasses for every row + *In input

All repo functions take a `sqlite3.Connection` as the first positional arg so
they can be exercised with an in-memory DB in tests and injected from the
orchestrator at runtime.
"""

from .migrations import apply_migrations, init_db
from . import models, repo

__all__ = ["apply_migrations", "init_db", "models", "repo"]
