"""Canonical data model (BLUEPRINT §5.1).

Every record the system reasons about is defined here, once. Three invariants
are enforced in ``__post_init__`` rather than left to convention, because each
one guards a failure mode that is silent and expensive:

* **Timestamps are timezone-aware UTC.** A naive datetime compares against an
  aware one by raising, or worse, compares against another naive one under an
  unstated local offset. Point-in-time correctness (§6.1) is a statement about
  timestamp ordering, so an ambiguous timestamp is an unsound backtest.
* **Prices are integer cents in [0, 100].** Floats accumulate representation
  error across fee and P&L arithmetic; a price outside the range means the
  venue payload was misread.
* **``rules_hash`` matches ``rules_text``.** ``Market`` is versioned rather
  than updated in place, and the hash is what distinguishes one version from
  the next. A hash that does not match its text silently merges two versions.

Nothing here interprets the data. Derivations that *are* defined here — the
two-sided book view below — are representational, not strategic.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Literal

__all__ = [
    "PRICE_MAX_CENTS",
    "PRICE_MIN_CENTS",
    "BookSnapshot",
    "Level",
    "Market",
    "Outcome",
    "Resolution",
    "Side",
    "StrikeType",
    "Trade",
    "TwoSidedBook",
    "rules_hash_of",
]

#: A binary contract settles at 0c or 100c, so every price lives in that range.
#: The bounds are inclusive: 0 and 100 are legal marks even though the venue
#: only accepts orders strictly between them.
PRICE_MIN_CENTS = 0
PRICE_MAX_CENTS = 100

#: ``(price_cents, size)``. Kept as a plain tuple to match the wire-adjacent
#: shape of a book level and to keep snapshots cheap to construct in bulk.
type Level = tuple[int, int]

Side = Literal["yes", "no"]
Outcome = Literal["yes", "no", "void"]
StrikeType = Literal["greater", "less", "between"]


def rules_hash_of(rules_text: str) -> str:
    """Return the canonical ``rules_hash`` for ``rules_text`` (§5.1)."""
    return hashlib.sha256(rules_text.encode("utf-8")).hexdigest()


def _require_utc(field: str, value: datetime) -> None:
    if value.tzinfo is None:
        raise ValueError(f"{field} must be timezone-aware, got naive {value!r}")
    if value.utcoffset() != timedelta(0):
        raise ValueError(f"{field} must be UTC, got offset {value.utcoffset()!r}")


def _require_levels(field: str, levels: tuple[Level, ...]) -> None:
    seen: set[int] = set()
    for price, size in levels:
        if not PRICE_MIN_CENTS <= price <= PRICE_MAX_CENTS:
            raise ValueError(
                f"{field} price {price} outside "
                f"[{PRICE_MIN_CENTS}, {PRICE_MAX_CENTS}] cents"
            )
        if size < 0:
            raise ValueError(f"{field} size {size} is negative")
        if price in seen:
            raise ValueError(f"{field} has duplicate price level {price}")
        seen.add(price)


@dataclass(frozen=True, slots=True)
class Market:
    """One version of a market's metadata.

    Versioned, never updated in place. Venues edit rules text after listing,
    and a backtest that evaluates a pre-amendment decision against
    post-amendment rules is using information that did not exist. ``as_of()``
    serves the version live at time ``t``; ``observed_at`` is when *we* first
    saw *this* version, not when the venue changed it.
    """

    venue: str
    market_id: str
    venue_ticker: str
    series_ticker: str
    event_ticker: str
    title: str
    rules_text: str
    rules_hash: str
    resolution_source: str | None
    category: str
    open_ts: datetime
    close_ts: datetime
    expected_settle_ts: datetime | None
    tick_size_cents: int
    strike_type: StrikeType | None
    floor_strike: float | None
    cap_strike: float | None
    observed_at: datetime

    def __post_init__(self) -> None:
        _require_utc("open_ts", self.open_ts)
        _require_utc("close_ts", self.close_ts)
        _require_utc("observed_at", self.observed_at)
        if self.expected_settle_ts is not None:
            _require_utc("expected_settle_ts", self.expected_settle_ts)
        expected = rules_hash_of(self.rules_text)
        if self.rules_hash != expected:
            raise ValueError(
                f"rules_hash {self.rules_hash!r} does not match rules_text "
                f"(expected {expected!r})"
            )
        if self.tick_size_cents <= 0:
            raise ValueError(
                f"tick_size_cents must be positive, got {self.tick_size_cents}"
            )


@dataclass(frozen=True, slots=True)
class BookSnapshot:
    """The venue-native book: resting YES bids and resting NO bids.

    Stored exactly as Kalshi expresses it. The canonical two-sided view is
    derived on demand by :meth:`two_sided` rather than at ingest, so the
    recorded form stays faithful to the wire and the derivation stays testable
    in one place.
    """

    market_id: str
    venue_ts: datetime
    recv_ts: datetime
    seq: int
    yes_levels: tuple[Level, ...]
    no_levels: tuple[Level, ...]

    def __post_init__(self) -> None:
        _require_utc("venue_ts", self.venue_ts)
        _require_utc("recv_ts", self.recv_ts)
        _require_levels("yes_levels", self.yes_levels)
        _require_levels("no_levels", self.no_levels)

    def two_sided(self) -> TwoSidedBook:
        """Derive the canonical two-sided view of the YES contract.

        A resting NO bid at ``n`` cents is an offer to sell YES at
        ``100 - n`` cents: the counterparty who lifts it ends up long YES at
        that price. So NO bids become YES asks under the ``100 - n`` reflection
        and the size carries across unchanged.

        Getting this inversion wrong flips the sign of the entire P&L, and the
        resulting book still looks plausible, which is why it is derived here
        once and round-trip tested rather than open-coded per call site.
        """
        bids = tuple(sorted(self.yes_levels, key=lambda level: -level[0]))
        asks = tuple(
            sorted(
                ((PRICE_MAX_CENTS - price, size) for price, size in self.no_levels),
                key=lambda level: level[0],
            )
        )
        return TwoSidedBook(
            market_id=self.market_id,
            venue_ts=self.venue_ts,
            recv_ts=self.recv_ts,
            seq=self.seq,
            bids=bids,
            asks=asks,
        )


@dataclass(frozen=True, slots=True)
class TwoSidedBook:
    """The canonical view: YES bids and YES asks, both in YES price terms.

    ``bids`` are ordered best (highest) first and ``asks`` best (lowest) first,
    so ``bids[0]`` and ``asks[0]`` are the touch.
    """

    market_id: str
    venue_ts: datetime
    recv_ts: datetime
    seq: int
    bids: tuple[Level, ...]
    asks: tuple[Level, ...]

    def __post_init__(self) -> None:
        _require_utc("venue_ts", self.venue_ts)
        _require_utc("recv_ts", self.recv_ts)
        _require_levels("bids", self.bids)
        _require_levels("asks", self.asks)

    def to_venue(self) -> BookSnapshot:
        """Invert :meth:`BookSnapshot.two_sided`, returning the venue-native form."""
        return BookSnapshot(
            market_id=self.market_id,
            venue_ts=self.venue_ts,
            recv_ts=self.recv_ts,
            seq=self.seq,
            yes_levels=self.bids,
            no_levels=tuple(
                (PRICE_MAX_CENTS - price, size) for price, size in self.asks
            ),
        )

    @property
    def best_bid(self) -> Level | None:
        """Highest resting YES bid, or ``None`` on an empty side."""
        return self.bids[0] if self.bids else None

    @property
    def best_ask(self) -> Level | None:
        """Lowest resting YES ask, or ``None`` on an empty side."""
        return self.asks[0] if self.asks else None


@dataclass(frozen=True, slots=True)
class Trade:
    """One executed trade, in YES price terms."""

    market_id: str
    venue_ts: datetime
    recv_ts: datetime
    price_cents: int
    size: int
    taker_side: Side

    def __post_init__(self) -> None:
        _require_utc("venue_ts", self.venue_ts)
        _require_utc("recv_ts", self.recv_ts)
        if not PRICE_MIN_CENTS <= self.price_cents <= PRICE_MAX_CENTS:
            raise ValueError(
                f"price_cents {self.price_cents} outside "
                f"[{PRICE_MIN_CENTS}, {PRICE_MAX_CENTS}] cents"
            )
        if self.size <= 0:
            raise ValueError(f"trade size must be positive, got {self.size}")


@dataclass(frozen=True, slots=True)
class Resolution:
    """Settlement outcome for a market.

    ``"void"`` is a real outcome, not an error: voided markets must not be
    silently dropped from the sample, because dropping them selects on the
    markets that resolved cleanly (§6.1).
    """

    market_id: str
    settled_ts: datetime
    outcome: Outcome
    disputed: bool
    notes: str | None

    def __post_init__(self) -> None:
        _require_utc("settled_ts", self.settled_ts)
