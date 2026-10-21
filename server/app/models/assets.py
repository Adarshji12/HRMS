"""Company assets and their custody chain.

Two tables: ``assets`` is the register (one row per physical thing the company
owns), ``asset_assignments`` is the custody ledger (one row per time it changed
hands). The ledger is append-and-close: handing a laptop over inserts a row,
taking it back sets ``returned_at`` on that same row. Nothing is ever deleted,
because "who had this machine in March" is exactly the question an asset
register exists to answer.

**The one design decision a reader would otherwise get wrong:** an asset may
have at most one *open* assignment (``returned_at IS NULL``) at a time, and that
is enforced by the database, not by the service layer — see
``AssetAssignment.__table_args__``. ``Asset.status`` is a denormalised cache of
that fact and is *not* enforced; the service that opens or closes an assignment
must move ``status`` in the same transaction.

The module is deliberately standalone. Onboarding's ``it_setup`` task and
offboarding's ``it_asset_return`` task drive it from outside by calling the
assets service; nothing here imports or knows about either, so the Assets page
works on its own in an org that never adopts those checklists.
"""

from __future__ import annotations

import enum
import uuid
from datetime import date, datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    BigInteger,
    Boolean,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    Uuid,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin, UUIDMixin, utcnow

if TYPE_CHECKING:
    from app.models.user import User


class AssetCategory(str, enum.Enum):
    """The categories the console offers out of the box.

    Not a closed set: ``Asset.category`` accepts any lower-case slug, because
    "anything the company owns" includes software licences, domains, vehicles
    and insurance policies that no fixed list anticipates. These are the
    suggestions, and the value every unrecognised slug reads back as.
    """

    LAPTOP = "laptop"
    DESKTOP = "desktop"
    MONITOR = "monitor"
    MOBILE = "mobile"
    TABLET = "tablet"
    SIM = "sim"
    ID_CARD = "id_card"
    PRINTER = "printer"
    NETWORKING = "networking"
    FURNITURE = "furniture"
    VEHICLE = "vehicle"
    MACHINERY = "machinery"
    SOFTWARE_LICENSE = "software_license"
    SUBSCRIPTION = "subscription"
    DOMAIN_HOSTING = "domain_hosting"
    INSURANCE = "insurance"
    AMC = "amc"
    OTHER = "other"


class RenewalCycle(str, enum.Enum):
    """How far one renewal pushes the next due date.

    ``none`` still allows a renewal date — a one-off certificate expiry — but
    renewing it asks for the next date explicitly instead of computing one.
    """

    NONE = "none"
    MONTHLY = "monthly"
    QUARTERLY = "quarterly"
    HALF_YEARLY = "half_yearly"
    YEARLY = "yearly"
    TWO_YEARS = "two_years"
    THREE_YEARS = "three_years"

    @property
    def months(self) -> int:
        return {
            "none": 0, "monthly": 1, "quarterly": 3, "half_yearly": 6,
            "yearly": 12, "two_years": 24, "three_years": 36,
        }[self.value]


class AssetStatus(str, enum.Enum):
    AVAILABLE = "available"
    ASSIGNED = "assigned"
    UNDER_REPAIR = "under_repair"
    RETIRED = "retired"

    @property
    def is_assignable(self) -> bool:
        """Only an idle asset can be handed to someone.

        ``under_repair`` and ``retired`` are excluded on purpose: issuing a
        machine that is in the repair queue, or one that has been written off,
        is a mistake the register should refuse rather than record.
        """
        return self is AssetStatus.AVAILABLE


class Asset(UUIDMixin, TimestampMixin, Base):
    """One physical item the company owns and can hand to an employee."""

    __tablename__ = "assets"
    __table_args__ = (
        # Unique *per org*, never globally: two tenants both labelling their
        # first laptop "LAP-001" is the normal case, and a global unique index
        # would make the second tenant's first asset fail to save.
        UniqueConstraint("org_id", "asset_tag", name="uq_assets_org_tag"),
        # The register's default view is "this org, filtered by status".
        Index("ix_assets_org_status", "org_id", "status"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )

    # The label physically stuck on the item. Human-assigned, not generated:
    # most companies already have a tagging scheme and importing their existing
    # one must not require renaming every sticker.
    asset_tag: Mapped[str] = mapped_column(String(64), nullable=False)
    category: Mapped[str] = mapped_column(
        String(40), default=AssetCategory.OTHER.value, nullable=False
    )
    # What a person calls it ("Dell Latitude 5420", "Microsoft 365 E3"). The tag
    # is the sticker; this is the line a report reader recognises.
    name: Mapped[str | None] = mapped_column(String(160), nullable=True)
    brand: Mapped[str | None] = mapped_column(String(120), nullable=True)
    model_name: Mapped[str | None] = mapped_column(String(120), nullable=True)
    # Nullable because an ID card or a desk chair genuinely has no serial, and
    # forcing a placeholder value would poison de-duplication later.
    serial_number: Mapped[str | None] = mapped_column(String(120), nullable=True)
    # A procurement date, not an instant: the invoice says a day, and storing
    # it as a timestamp would invent a timezone the finance team never gave us.
    purchase_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    vendor: Mapped[str | None] = mapped_column(String(160), nullable=True)
    invoice_number: Mapped[str | None] = mapped_column(String(80), nullable=True)
    # Integer paise, like every other amount in this codebase.
    purchase_cost_paise: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    location: Mapped[str | None] = mapped_column(String(160), nullable=True)
    warranty_expiry: Mapped[date | None] = mapped_column(Date, nullable=True)

    # Renewal tracking. ``renewal_date`` is the *next* due date and NULL means
    # the asset is not tracked for renewal at all; renewing it records a row in
    # ``asset_renewals`` and moves this date forward.
    renewal_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    renewal_cycle: Mapped[str] = mapped_column(
        String(20), default=RenewalCycle.NONE.value, server_default="none", nullable=False
    )
    renewal_cost_paise: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    # How many days ahead of the due date the asset counts as "due soon".
    reminder_days: Mapped[int] = mapped_column(
        Integer, default=30, server_default="30", nullable=False
    )
    auto_renew: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="0", nullable=False
    )
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    status: Mapped[str] = mapped_column(
        String(20), default=AssetStatus.AVAILABLE.value, nullable=False
    )

    # delete-orphan: deleting an asset row takes its custody history with it.
    # That is only reachable from a hard delete (the UI retires assets instead),
    # and a custody ledger pointing at an asset that no longer exists would be
    # unreadable anyway.
    assignments: Mapped[list["AssetAssignment"]] = relationship(
        back_populates="asset",
        cascade="all, delete-orphan",
        order_by="AssetAssignment.assigned_at.desc()",
    )

    renewals: Mapped[list["AssetRenewal"]] = relationship(
        back_populates="asset",
        cascade="all, delete-orphan",
        order_by="AssetRenewal.renewed_on.desc()",
    )

    @property
    def status_enum(self) -> AssetStatus:
        # Mirrors Project.status_enum: a value written by an older build, or by
        # hand in the database, must not raise on read. Falls back to the inert
        # end of the range — an unrecognised status must never read as
        # assignable, because that would hand out a machine we know nothing
        # about.
        try:
            return AssetStatus(self.status)
        except ValueError:
            return AssetStatus.RETIRED

    @property
    def category_enum(self) -> AssetCategory:
        try:
            return AssetCategory(self.category)
        except ValueError:
            return AssetCategory.OTHER

    @property
    def current_assignment(self) -> "AssetAssignment | None":
        """The open assignment, or None when nobody holds this asset.

        Reads the loaded ``assignments`` collection, so it is only cheap when
        the caller eager-loaded it. A list endpoint should query the open rows
        once and attach the holder itself rather than touching this per row.
        The partial unique index guarantees there is at most one to find.
        """
        for assignment in self.assignments:
            if assignment.returned_at is None:
                return assignment
        return None


class AssetAssignment(UUIDMixin, TimestampMixin, Base):
    """One custody period: who held an asset, from when, until when."""

    __tablename__ = "asset_assignments"
    __table_args__ = (
        # THE invariant of this module: an asset can be out with at most one
        # person at a time.
        #
        # A *partial* unique index on asset_id restricted to open rows is the
        # only formulation that says this. A plain unique index on asset_id
        # would forbid ever re-issuing an asset; a unique index on
        # (asset_id, returned_at) would not constrain anything at all, because
        # NULLs do not collide.
        #
        # This is portable here, not Postgres-only: SQLite has supported
        # partial indexes since 3.8.0 and the dev database is far newer, so the
        # same DDL is emitted for both backends and both reject the second open
        # row with an IntegrityError. The dialect kwargs are spelled twice
        # because SQLAlchemy scopes index WHERE clauses per dialect; drop either
        # one and the invariant silently disappears on that backend.
        #
        # Named explicitly (the naming convention would not produce a name that
        # says what this is) so SQLite batch-mode ALTER can recreate it and a
        # later migration can drop it by name.
        Index(
            "uq_asset_assignments_open_per_asset",
            "asset_id",
            unique=True,
            sqlite_where=text("returned_at IS NULL"),
            postgresql_where=text("returned_at IS NULL"),
        ),
        # "What am I currently holding" and "what is this leaver still holding"
        # are both this index; offboarding asks the second one per employee.
        Index("ix_asset_assignments_user_returned", "user_id", "returned_at"),
    )

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    asset_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("assets.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # CASCADE matches the rest of the schema, and is safe here because
    # offboarding deactivates users rather than deleting them: this only fires
    # on a genuine hard delete (tenant wipe, erasure request), where keeping a
    # custody row that names a person who no longer exists would be worse.
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )

    # An instant, not a date: two handovers on the same day must still order.
    # Defaulted rather than required so the common "hand it over now" path does
    # not have to supply it, but settable so HR can record a past handover.
    assigned_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )
    # NULL is load-bearing: it means "still held", and it is what the partial
    # unique index above keys off. Never write a sentinel here.
    returned_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # Free text on both sides on purpose. "Screen has a scratch, bottom left"
    # is what settles a dispute at return time; a condition *grade* would throw
    # away the only part anyone actually reads.
    assigned_condition_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    returned_condition_note: Mapped[str | None] = mapped_column(Text, nullable=True)

    asset: Mapped["Asset"] = relationship(back_populates="assignments")
    user: Mapped["User"] = relationship()

    @property
    def is_open(self) -> bool:
        return self.returned_at is None


class AssetRenewal(UUIDMixin, TimestampMixin, Base):
    """One renewal of an asset: paid on a day, moved the due date from X to Y.

    Append-only, like the custody ledger: "what did we pay for the antivirus
    licence last year" is answered here, not reconstructed from audit logs.
    """

    __tablename__ = "asset_renewals"

    org_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    asset_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("assets.id", ondelete="CASCADE"), nullable=False, index=True
    )
    renewed_on: Mapped[date] = mapped_column(Date, nullable=False)
    previous_due: Mapped[date | None] = mapped_column(Date, nullable=True)
    # NULL when the renewal closed tracking (e.g. the subscription was ended).
    next_due: Mapped[date | None] = mapped_column(Date, nullable=True)
    cost_paise: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    reference: Mapped[str | None] = mapped_column(String(120), nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    renewed_by_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    asset: Mapped["Asset"] = relationship(back_populates="renewals")
