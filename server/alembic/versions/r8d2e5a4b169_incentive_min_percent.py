"""Minimum achievement percentage for the incentive rule

Revision ID: r8d2e5a4b169
Revises: q7c1d4f3a058
"""

import sqlalchemy as sa
from alembic import op

revision = "r8d2e5a4b169"
down_revision = "q7c1d4f3a058"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("sales_incentive_settings") as batch:
        batch.add_column(sa.Column("min_percent", sa.Integer(), nullable=False, server_default="80"))


def downgrade() -> None:
    with op.batch_alter_table("sales_incentive_settings") as batch:
        batch.drop_column("min_percent")
