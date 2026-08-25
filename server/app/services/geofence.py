"""Haversine distance and the "is this punch at an office" verdict.

Deliberately **function-only, with no database, no ORM and no FastAPI import**.
Spec §8 asks for exactly this, and the reason is that it is the piece with the
most edge cases per line in the whole module: the antimeridian, the poles, a
punch with no coordinates, an org with no offices, a device that admits to a
±500 m fix. Every one of those is a plain function call away from a test here,
and none of them needs a tenant, a session or a transaction to reproduce. The
moment this module imports ``Session``, that stops being true and the tests
start needing fixtures to assert arithmetic.

The caller therefore converts its ``OfficeLocation`` rows into :class:`Fence`
values and hands them in. That conversion is one comprehension in
``services/attendance.py`` and it is what keeps this file honest.

The other decision worth stating: **being outside every fence is a verdict, not
an error.** :func:`resolve` always returns a :class:`GeoVerdict`; it never
raises. Whether an unverified punch is refused is a *policy* question that
belongs to the enforcement mode in the attendance service, not to the geometry.
"""

from __future__ import annotations

import math
import uuid
from dataclasses import dataclass
from typing import Iterable, Sequence

#: IUGG mean Earth radius, in metres. A sphere, not WGS-84: the ellipsoidal
#: (Vincenty/Karney) correction is at most ~0.5% of the distance, which over a
#: 200 m geofence is one metre — an order of magnitude inside the GPS error the
#: fence is sized to absorb in the first place. Paying for an iterative solver
#: that can fail to converge, to win a metre nobody can stand in, is the wrong
#: trade for this call site.
EARTH_RADIUS_M = 6_371_008.8


@dataclass(frozen=True)
class Fence:
    """One geofenced site, flattened out of the ``office_locations`` row.

    Frozen and id-carrying rather than a bare ``(lat, lng, radius)`` tuple: the
    punch response has to name the office that matched ("recorded at
    Whitefield"), and a tuple would make every caller re-derive which row won by
    comparing floats.
    """

    id: uuid.UUID | None
    name: str
    lat: float
    lng: float
    radius_m: int


@dataclass(frozen=True)
class GeoVerdict:
    """The answer for one punch: verified or not, how far, and from what.

    ``distance_m`` is ``None`` in the two genuinely unknowable cases — no
    coordinate was supplied, or the organisation has no active office to measure
    against — and an integer otherwise. It is deliberately *not* zero in those
    cases: ``attendance_records.check_in_distance_m`` is read by managers, and a
    stored 0 would say "standing in the office doorway" about a punch nobody
    ever located.
    """

    is_verified: bool
    distance_m: int | None = None
    office_id: uuid.UUID | None = None
    office_name: str | None = None
    #: True when the coordinate landed outside every fence and was only accepted
    #: because the device's own accuracy figure widened the radius. Recorded so a
    #: manager reviewing a flagged day can tell "50 m outside" from "we took the
    #: phone's word for it".
    within_accuracy_margin: bool = False


def haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Great-circle distance between two WGS-84 points, in metres.

    Haversine rather than the equirectangular approximation, which is faster and
    is wrong by metres at the latitudes this product actually runs at, and
    rather than the spherical law of cosines, which loses precision exactly
    where a geofence lives — at distances of a few hundred metres, where
    ``cos(d/R)`` sits within float noise of 1.
    """
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    d_phi = math.radians(lat2 - lat1)
    # The longitude delta is taken raw and converted, never pre-normalised into
    # ±180 by hand: sin() is periodic, so a pair straddling the antimeridian
    # (179.9 and -179.9) already resolves through the sine of the halved delta
    # as the short way round. Hand-wrapping it is how that pair becomes 40,000 km.
    d_lambda = math.radians(lng2 - lng1)

    a = (
        math.sin(d_phi / 2) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(d_lambda / 2) ** 2
    )
    # Clamped because floating point can put `a` a few ulps above 1 for
    # antipodal points, and ``math.sqrt(1 - a)`` would then raise on a negative.
    a = min(1.0, max(0.0, a))
    return 2 * EARTH_RADIUS_M * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def nearest_fence(
    lat: float, lng: float, fences: Sequence[Fence]
) -> tuple[Fence | None, float | None]:
    """The closest office and its distance, or ``(None, None)`` with no offices.

    Nearest by *centre distance*, not "the first fence whose radius contains the
    point". The two differ for overlapping fences — a small site inside a large
    campus — and the nearest centre is the one a human would name when asked
    where somebody punched from.
    """
    best: Fence | None = None
    best_distance: float | None = None
    for fence in fences:
        distance = haversine_m(lat, lng, fence.lat, fence.lng)
        if best_distance is None or distance < best_distance:
            best, best_distance = fence, distance
    return best, best_distance


def is_within(lat: float, lng: float, fence: Fence, accuracy_m: int | None = None) -> bool:
    """Whether one point falls inside one fence, widened by device accuracy."""
    return haversine_m(lat, lng, fence.lat, fence.lng) <= fence.radius_m + max(
        0, accuracy_m or 0
    )


def resolve(
    lat: float | None,
    lng: float | None,
    fences: Iterable[Fence],
    accuracy_m: int | None = None,
) -> GeoVerdict:
    """Verdict for one punch. Never raises; never rejects.

    Four cases, all of them normal:

    * **No coordinate.** The browser Geolocation API is a permission prompt, and
      a meaningful share of people deny it or sit at a desktop with no GPS.
      Unverified, distance unknown — and per spec §2.2 the punch still happens.
    * **No active offices.** A fully remote tenant, or one that has not added a
      site yet. There is nothing to be near, so nothing is verified and no
      distance is invented.
    * **Inside some fence.** Verified, naming the nearest office.
    * **Outside every fence.** Unverified, carrying the measured distance to the
      nearest one — the number that makes a flagged day reviewable at all.

    ``accuracy_m`` is the browser's own ``coords.accuracy`` in metres and widens
    every radius by that much. A device reporting ±500 m has stated outright
    that a hard fail against a 200 m circle is meaningless, and flagging it
    anyway is exactly the GPS-drift problem §2.2 exists to avoid. It only ever
    widens: a suspiciously precise ±1 m never *narrows* a fence below its
    configured radius, because the figure is client-supplied and a punch client
    must not be able to shrink its employer's geofence.
    """
    if lat is None or lng is None:
        return GeoVerdict(is_verified=False)

    fence_list = list(fences)
    if not fence_list:
        return GeoVerdict(is_verified=False)

    nearest, distance = nearest_fence(lat, lng, fence_list)
    if nearest is None or distance is None:  # pragma: no cover - empty handled above
        return GeoVerdict(is_verified=False)

    margin = max(0, accuracy_m or 0)
    # Verified against *any* fence rather than only the nearest: a tight radius
    # on the nearest centre beside a generous one on a slightly further site is a
    # real configuration, and §2.2 says "within radius_m of any of them".
    strict = any(haversine_m(lat, lng, f.lat, f.lng) <= f.radius_m for f in fence_list)
    lenient = strict or any(
        haversine_m(lat, lng, f.lat, f.lng) <= f.radius_m + margin for f in fence_list
    )

    return GeoVerdict(
        is_verified=lenient,
        # Rounded, because the column is an Integer and sub-metre precision on a
        # figure derived from a ±50 m fix is false confidence.
        distance_m=int(round(distance)),
        office_id=nearest.id,
        office_name=nearest.name,
        within_accuracy_margin=lenient and not strict,
    )
