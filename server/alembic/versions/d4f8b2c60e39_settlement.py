"""Full-and-final settlement: itemisation and the policy it needs

Revision ID: d4f8b2c60e39
Revises: c3e7a1b59d28
Create Date: 2026-08-25 11:00:00.000000

Offboarding has carried a settlement record since before payroll existed, and it
held three numbers an HR admin typed in from a spreadsheet. Payroll now exists,
so the calculation can happen here — and a calculated figure with no itemisation
is worse than a typed one, because nobody can check it. Hence a line table.

Four additive changes, no data migration:

* ``offboarding_fnf_lines`` — one row per component of a settlement.
* ``offboarding_fnf.computed_at`` — null on every existing row, which is
  accurate: they were all typed in.
* ``leave_types.is_encashable`` — **default False**. Turning it on for every
  existing type would make the first settlement anybody runs pay out casual and
  sick leave balances, which is the expensive direction to be wrong in.
* ``employee_profiles.notice_period_days`` — nullable, not defaulted. "Not
  recorded" and "none required" must stay different, or a settlement recovers
  notice pay against a number nobody set.

Plus five columns of settlement policy on ``statutory_configs``, which is where
company-wide statutory policy already lives. Their defaults are the Payment of
Gratuity Act's own figures (15 days, /26, ₹20,00,000 ceiling) with gratuity
itself switched **off** — a company with nobody near five years has nothing to
compute, and an accidentally-enabled gratuity is a large number appearing in a
settlement unasked.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'd4f8b2c60e39'
down_revision: Union[str, None] = 'c3e7a1b59d28'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "offboarding_fnf_lines",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("org_id", sa.Uuid(), nullable=False),
        sa.Column("fnf_id", sa.Uuid(), nullable=False),
        sa.Column("kind", sa.String(length=12), nullable=False),
        sa.Column("code", sa.String(length=32), nullable=False),
        sa.Column("label", sa.String(length=160), nullable=False),
        sa.Column("amount_paise", sa.Integer(), nullable=False,
                  server_default=sa.text("0")),
        sa.Column("source", sa.String(length=24), nullable=False,
                  server_default=sa.text("'manual'")),
        sa.Column("source_id", sa.Uuid(), nullable=True),
        sa.Column("detail", sa.Text(), nullable=True),
        sa.Column("sort_order", sa.Integer(), nullable=False,
                  server_default=sa.text("0")),
        # `created_at` only — `TimestampMixin` in this codebase defines exactly
        # one column, and a line is written once and never edited in place.
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["org_id"], ["organizations.id"], ondelete="CASCADE"),
        # CASCADE: a line has no meaning without the settlement it itemises.
        sa.ForeignKeyConstraint(["fnf_id"], ["offboarding_fnf.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_offboarding_fnf_lines_org_id", "offboarding_fnf_lines", ["org_id"])
    op.create_index("ix_offboarding_fnf_lines_fnf_id", "offboarding_fnf_lines", ["fnf_id"])
    op.create_index("ix_offboarding_fnf_lines_fnf", "offboarding_fnf_lines",
                    ["fnf_id", "sort_order"])

    with op.batch_alter_table("offboarding_fnf") as batch:
        batch.add_column(sa.Column("computed_at", sa.DateTime(timezone=True), nullable=True))

    with op.batch_alter_table("leave_types") as batch:
        batch.add_column(sa.Column("is_encashable", sa.Boolean(), nullable=False,
                                   server_default=sa.false()))

    with op.batch_alter_table("employee_profiles") as batch:
        batch.add_column(sa.Column("notice_period_days", sa.Integer(), nullable=True))

    with op.batch_alter_table("statutory_configs") as batch:
        batch.add_column(sa.Column("gratuity_enabled", sa.Boolean(), nullable=False,
                                   server_default=sa.false()))
        batch.add_column(sa.Column("gratuity_days_per_year", sa.Integer(), nullable=False,
                                   server_default=sa.text("15")))
        batch.add_column(sa.Column("gratuity_month_days", sa.Integer(), nullable=False,
                                   server_default=sa.text("26")))
        batch.add_column(sa.Column("gratuity_ceiling", sa.Integer(), nullable=False,
                                   server_default=sa.text("200000000")))
        batch.add_column(sa.Column("encashment_month_days", sa.Integer(), nullable=False,
                                   server_default=sa.text("26")))
        batch.add_column(sa.Column("encashment_on_basic", sa.Boolean(), nullable=False,
                                   server_default=sa.true()))


def downgrade() -> None:
    with op.batch_alter_table("statutory_configs") as batch:
        batch.drop_column("encashment_on_basic")
        batch.drop_column("encashment_month_days")
        batch.drop_column("gratuity_ceiling")
        batch.drop_column("gratuity_month_days")
        batch.drop_column("gratuity_days_per_year")
        batch.drop_column("gratuity_enabled")

    with op.batch_alter_table("employee_profiles") as batch:
        batch.drop_column("notice_period_days")

    with op.batch_alter_table("leave_types") as batch:
        batch.drop_column("is_encashable")

    with op.batch_alter_table("offboarding_fnf") as batch:
        batch.drop_column("computed_at")

    op.drop_index("ix_offboarding_fnf_lines_fnf", table_name="offboarding_fnf_lines")
    op.drop_index("ix_offboarding_fnf_lines_fnf_id", table_name="offboarding_fnf_lines")
    op.drop_index("ix_offboarding_fnf_lines_org_id", table_name="offboarding_fnf_lines")
    op.drop_table("offboarding_fnf_lines")
