"""server-load: no agent-side behaviour.

The Hermes plugin loader requires an ``__init__.py`` with ``register``; this plugin's work is
the dashboard route in ``dashboard/plugin_api.py`` and the Desktop half in ``desktop/plugin.js``.
"""

from __future__ import annotations

from typing import Any


def register(ctx: Any) -> None:
    return None
