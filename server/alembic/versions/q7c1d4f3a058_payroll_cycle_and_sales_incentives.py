"""Payroll cycle days, a TDS switch, and sales targets with incentives

Revision ID: q7c1d4f3a058
Revises: p6b0c3e2f947

Statutory config gains the cycle-close day, the salary-paid day and a TDS switch (on by default,
because TDS was always computed). Three new tables hold the incentive rule, each employee's
monthly target, and the incentives raised from them.
"""

import sqlalchemy as sa
from alembic import op

revision = "q7c1d4f3a058"
down_revision = "p6b0c3e2f947"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("statutory_configs") as batch:
        batch.add_column(sa.Column("cycle_close_day", sa.Integer(), nullable=False, server_default="31"))
        batch.add_column(sa.Column("salary_paid_day", sa.Integer(), nullable=False, server_default="7"))
        batch.add_column(sa.Column("tds_enabled", sa.Boolean(), nullable=False, server_default=sa.true()))

    op.create_table(
        "sales_incentive_settings",
        sa.Column("org_id", sa.Uuid(), nullable=False),
        sa.Column("is_enabled", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("target_type", sa.String(length=16), nullable=False, server_default="customers"),
        sa.Column("default_target", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("incentive_type", sa.String(length=8), nullable=False, server_default="fixed"),
        sa.Column("incentive_paise", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("achievement", sa.String(length=8), nullable=False, server_default="full"),
        sa.Column("requires_approval", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["org_id"], ["organizations.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("org_id"),
    )
    op.create_table(
        "sales_targets",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("org_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("period_year", sa.Integer(), nullable=False),
        sa.Column("period_month", sa.Integer(), nullable=False),
        sa.Column("target", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["org_id"], ["organizations.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("org_id", "user_id", "period_year", "period_month", name="uq_sales_targets_period"),
    )
    op.create_index("ix_sales_targets_org_id", "sales_targets", ["org_id"])
    op.create_table(
        "sales_incentives",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("org_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("period_year", sa.Integer(), nullable=False),
        sa.Column("period_month", sa.Integer(), nullable=False),
        sa.Column("target", sa.Integer(), nullable=False),
        sa.Column("achieved", sa.Integer(), nullable=False),
        sa.Column("amount", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(length=12), nullable=False, server_default="pending"),
        sa.Column("reviewed_by", sa.Uuid(), nullable=True),
        sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("review_note", sa.Text(), nullable=True),
        sa.Column("paid_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["org_id"], ["organizations.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["reviewed_by"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("org_id", "user_id", "period_year", "period_month", name="uq_sales_incentives_period"),
    )
    op.create_index("ix_sales_incentives_org_status", "sales_incentives", ["org_id", "status"])


def downgrade() -> None:
    op.drop_index("ix_sales_incentives_org_status", table_name="sales_incentives")
    op.drop_table("sales_incentives")
    op.drop_index("ix_sales_targets_org_id", table_name="sales_targets")
    op.drop_table("sales_targets")
    op.drop_table("sales_incentive_settings")
    with op.batch_alter_table("statutory_configs") as batch:
        batch.drop_column("tds_enabled")
        batch.drop_column("salary_paid_day")
        batch.drop_column("cycle_close_day")
