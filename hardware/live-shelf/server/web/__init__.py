"""Live Shelf web UI package (Bundle G).

Owns all HTML rendering + non-intake / non-scale JSON endpoints for the
demo dashboard. Scale ingestion endpoints (``/api/scale-event``,
``/api/scale-heartbeat``) live in Bundle H and the intake wizard
(``/intake``, ``/api/intake/*``) lives in Bundle F.

Public entrypoints:

    * :class:`server.web.routes.WebRepo` — read-side protocol the UI needs
    * :func:`server.web.routes.make_html_bp` — HTML blueprint factory
    * :func:`server.web.api_routes.make_api_bp` — JSON blueprint factory

Both factories accept the repo + a data directory used to serve the per-event
image artifacts under ``data/events/<event_id>/{before,after}.jpg``.
"""

from __future__ import annotations

from .api_routes import make_api_bp
from .routes import WebRepo, make_html_bp

__all__ = ["WebRepo", "make_html_bp", "make_api_bp"]
