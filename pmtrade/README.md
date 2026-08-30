# pmtrade

Research system that answers one question: **does a measurable, repeatable edge
exist over Kalshi's prices on economic contracts, after costs?**

The design lives in [`BLUEPRINT.md`](BLUEPRINT.md) alongside this file. The
non-negotiable rules live in `CLAUDE.md`, which is not checked in here because
the host repository gitignores that filename. "No edge found" is a complete
and successful outcome.

This project places no orders. Milestones M0–M10 use a dry-run broker only.

## Layout

| Path | Blueprint section |
| --- | --- |
| `pmtrade/types.py` | §5.1 canonical data model |
| `pmtrade/ingest/` | §2 ingest, §9 Kalshi API notes |
| `pmtrade/store/` | §5.2 storage layout, §6.1 point-in-time boundary |
| `pmtrade/research/` | §6.2 backtest engine, §8.1 costs, §10 evaluation |
| `pmtrade/strategy/` | §7 strategies |
| `pmtrade/risk/` | §8.2–§8.4 sizing, clusters, limits |
| `pmtrade/execution/` | `DryRunBroker`, the only broker |
| `docs/milestones/` | one report per milestone, with numbers |

## Development

Requires [uv](https://docs.astral.sh/uv/) and Python 3.12.

```bash
uv sync --frozen          # create .venv from uv.lock
uv run ruff format --check .
uv run ruff check .
uv run mypy
uv run pytest
```

`data/` is gitignored, append-only, and never mutated in place.
