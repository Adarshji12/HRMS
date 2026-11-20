"""Leave: who a type is offered to, when it is earned, and the org-level policy flags

Revision ID: o5a9b2d1e836
Revises: n4f8a1c0d725

Defaults leave every existing type available to everyone from day one.
"""

import sqlalchemy as sa
from alembic import op

revision = "o5a9b2d1e836"
down_revision = "n4f8a1c0d725"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("leave_types") as batch:
        batch.add_column(sa.Column("color", sa.String(length=9), nullable=False, server_default="#0ea5e9"))
        batch.add_column(sa.Column("offered_to", sa.String(length=8), nullable=False, server_default="all"))
        batch.add_column(sa.Column("min_service_months", sa.Integer(), nullable=False, server_default="0"))
        batch.add_column(sa.Column("proof_after_days", sa.Integer(), nullable=False, server_default="0"))
        batch.add_column(sa.Column("max_per_month_milli_days", sa.Integer(), nullable=False, server_default="0"))
    with op.batch_alter_table("leave_settings") as batch:
        batch.add_column(sa.Column("carry_forward_enabled", sa.Boolean(), nullable=False, server_default=sa.true()))
        batch.add_column(sa.Column("carry_forward_max_milli_days", sa.Integer(), nullable=False, server_default="15000"))
        batch.add_column(sa.Column("encash_enabled", sa.Boolean(), nullable=False, server_default=sa.false()))
        batch.add_column(sa.Column("manager_before_hr", sa.Boolean(), nullable=False, server_default=sa.true()))


def downgrade() -> None:
    with op.batch_alter_table("leave_settings") as batch:
        for column in ("manager_before_hr", "encash_enabled", "carry_forward_max_milli_days", "carry_forward_enabled"):
            batch.drop_column(column)
    with op.batch_alter_table("leave_types") as batch:
        for column in ("max_per_month_milli_days", "proof_after_days", "min_service_months", "offered_to", "color"):
            batch.drop_column(column)
