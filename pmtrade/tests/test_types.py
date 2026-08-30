"""Tests for the canonical data model (BLUEPRINT §5.1).

The book-representation tests carry the most weight here. Kalshi expresses a
book as resting YES bids and resting NO bids; the canonical view is YES bids
and YES asks. A YES bid at 40c is a NO ask at 60c, and inverting that mapping
flips the sign of the entire P&L while leaving a book that still looks
plausible. §5.1 asks specifically for a round-trip assertion, so there is both
a worked example and a property test over random books.
"""

from __future__ import annotations

import dataclasses
from datetime import UTC, datetime, timedelta, timezone

import pytest
from hypothesis import given
from hypothesis import strategies as st

from pmtrade.types import (
    PRICE_MAX_CENTS,
    BookSnapshot,
    Level,
    Market,
    Resolution,
    Trade,
    TwoSidedBook,
    rules_hash_of,
)

T0 = datetime(2026, 8, 30, 14, 0, tzinfo=UTC)


def _market(**overrides: object) -> Market:
    rules_text = "Resolves YES if CPI YoY is between 2.5% and 2.9% inclusive."
    fields: dict[str, object] = {
        "venue": "kalshi",
        "market_id": "kalshi:CPI-26SEP-B2.7",
        "venue_ticker": "CPI-26SEP-B2.7",
        "series_ticker": "CPI",
        "event_ticker": "CPI-26SEP",
        "title": "CPI YoY 2.5-2.9%",
        "rules_text": rules_text,
        "rules_hash": rules_hash_of(rules_text),
        "resolution_source": "BLS",
        "category": "Economics",
        "open_ts": T0,
        "close_ts": T0 + timedelta(days=14),
        "expected_settle_ts": T0 + timedelta(days=14, hours=1),
        "tick_size_cents": 1,
        "strike_type": "between",
        "floor_strike": 2.5,
        "cap_strike": 2.9,
        "observed_at": T0,
    }
    fields.update(overrides)
    return Market(**fields)  # type: ignore[arg-type]


def _book(yes_levels: tuple[Level, ...], no_levels: tuple[Level, ...]) -> BookSnapshot:
    return BookSnapshot(
        market_id="kalshi:CPI-26SEP-B2.7",
        venue_ts=T0,
        recv_ts=T0 + timedelta(milliseconds=12),
        seq=7,
        yes_levels=yes_levels,
        no_levels=no_levels,
    )


class TestBookRepresentation:
    def test_no_bid_becomes_yes_ask_at_the_complement(self) -> None:
        """The worked example from §5.1: a YES bid at 40c is a NO ask at 60c."""
        book = _book(yes_levels=((40, 100),), no_levels=((55, 25),))

        canonical = book.two_sided()

        assert canonical.bids == ((40, 100),)
        assert canonical.asks == ((45, 25),)
        assert canonical.best_bid == (40, 100)
        assert canonical.best_ask == (45, 25)

    def test_touch_is_not_crossed(self) -> None:
        """Best bid below best ask, which is what a sign inversion would break."""
        canonical = _book(yes_levels=((40, 100),), no_levels=((55, 25),)).two_sided()

        best_bid = canonical.best_bid
        best_ask = canonical.best_ask
        assert best_bid is not None
        assert best_ask is not None
        assert best_bid[0] < best_ask[0]

    def test_bids_are_best_first_and_asks_are_best_first(self) -> None:
        canonical = _book(
            yes_levels=((38, 5), (41, 9), (39, 7)),
            no_levels=((52, 3), (58, 11), (55, 6)),
        ).two_sided()

        assert canonical.bids == ((41, 9), (39, 7), (38, 5))
        assert canonical.asks == ((42, 11), (45, 6), (48, 3))

    def test_empty_sides_have_no_touch(self) -> None:
        canonical = _book(yes_levels=(), no_levels=()).two_sided()

        assert canonical.best_bid is None
        assert canonical.best_ask is None

    @given(
        yes_levels=st.lists(
            st.tuples(st.integers(0, PRICE_MAX_CENTS), st.integers(0, 10_000)),
            max_size=12,
            unique_by=lambda level: level[0],
        ),
        no_levels=st.lists(
            st.tuples(st.integers(0, PRICE_MAX_CENTS), st.integers(0, 10_000)),
            max_size=12,
            unique_by=lambda level: level[0],
        ),
    )
    def test_venue_to_canonical_round_trips(
        self, yes_levels: list[Level], no_levels: list[Level]
    ) -> None:
        """Every venue-native book survives the derivation and its inverse.

        Sizes and level identities must be preserved exactly; only the ordering
        of the stored tuples is normalised, so the comparison is set-wise on
        each side.
        """
        book = _book(tuple(yes_levels), tuple(no_levels))

        recovered = book.two_sided().to_venue()

        assert set(recovered.yes_levels) == set(book.yes_levels)
        assert set(recovered.no_levels) == set(book.no_levels)
        assert (
            dataclasses.replace(
                recovered, yes_levels=book.yes_levels, no_levels=book.no_levels
            )
            == book
        )

    @given(
        bids=st.lists(
            st.tuples(st.integers(0, PRICE_MAX_CENTS), st.integers(0, 10_000)),
            max_size=12,
            unique_by=lambda level: level[0],
        ),
        asks=st.lists(
            st.tuples(st.integers(0, PRICE_MAX_CENTS), st.integers(0, 10_000)),
            max_size=12,
            unique_by=lambda level: level[0],
        ),
    )
    def test_canonical_to_venue_round_trips(
        self, bids: list[Level], asks: list[Level]
    ) -> None:
        canonical = TwoSidedBook(
            market_id="kalshi:CPI-26SEP-B2.7",
            venue_ts=T0,
            recv_ts=T0,
            seq=1,
            bids=tuple(sorted(bids, key=lambda level: -level[0])),
            asks=tuple(sorted(asks, key=lambda level: level[0])),
        )

        assert canonical.to_venue().two_sided() == canonical


class TestTimestampInvariants:
    def test_naive_timestamp_is_rejected(self) -> None:
        with pytest.raises(ValueError, match="timezone-aware"):
            _market(observed_at=datetime(2026, 8, 30, 14, 0))

    def test_non_utc_timestamp_is_rejected(self) -> None:
        eastern = timezone(timedelta(hours=-4))
        with pytest.raises(ValueError, match="must be UTC"):
            _market(observed_at=T0.astimezone(eastern))

    def test_optional_timestamp_may_be_absent(self) -> None:
        assert _market(expected_settle_ts=None).expected_settle_ts is None


class TestMarketVersioning:
    def test_rules_hash_must_match_rules_text(self) -> None:
        with pytest.raises(ValueError, match="does not match rules_text"):
            _market(rules_hash=rules_hash_of("some other rules text"))

    def test_amended_rules_produce_a_distinct_hash(self) -> None:
        """Versioning depends on the hash separating one text from the next."""
        original = _market()
        amended_text = original.rules_text + " Revised 2026-09-02."
        amended = _market(
            rules_text=amended_text,
            rules_hash=rules_hash_of(amended_text),
            observed_at=T0 + timedelta(days=3),
        )

        assert amended.rules_hash != original.rules_hash

    def test_non_positive_tick_size_is_rejected(self) -> None:
        with pytest.raises(ValueError, match="tick_size_cents must be positive"):
            _market(tick_size_cents=0)


class TestPriceAndSizeInvariants:
    @pytest.mark.parametrize("price", [-1, 101])
    def test_book_price_outside_range_is_rejected(self, price: int) -> None:
        with pytest.raises(ValueError, match="outside"):
            _book(yes_levels=((price, 10),), no_levels=())

    def test_negative_book_size_is_rejected(self) -> None:
        with pytest.raises(ValueError, match="size -1 is negative"):
            _book(yes_levels=((40, -1),), no_levels=())

    def test_duplicate_price_level_is_rejected(self) -> None:
        with pytest.raises(ValueError, match="duplicate price level"):
            _book(yes_levels=((40, 10), (40, 5)), no_levels=())

    def test_trade_price_outside_range_is_rejected(self) -> None:
        with pytest.raises(ValueError, match="outside"):
            Trade(
                market_id="kalshi:CPI-26SEP-B2.7",
                venue_ts=T0,
                recv_ts=T0,
                price_cents=101,
                size=1,
                taker_side="yes",
            )

    def test_non_positive_trade_size_is_rejected(self) -> None:
        with pytest.raises(ValueError, match="trade size must be positive"):
            Trade(
                market_id="kalshi:CPI-26SEP-B2.7",
                venue_ts=T0,
                recv_ts=T0,
                price_cents=40,
                size=0,
                taker_side="yes",
            )


class TestImmutability:
    def test_records_are_frozen(self) -> None:
        resolution = Resolution(
            market_id="kalshi:CPI-26SEP-B2.7",
            settled_ts=T0,
            outcome="void",
            disputed=False,
            notes=None,
        )

        with pytest.raises(dataclasses.FrozenInstanceError):
            resolution.outcome = "yes"  # type: ignore[misc]
