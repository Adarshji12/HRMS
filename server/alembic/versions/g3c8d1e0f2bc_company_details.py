"""Company master details

Revision ID: g3c8d1e0f2bc
Revises: f2b7c0d9e1ab
"""

import sqlalchemy as sa
from alembic import op

revision = "g3c8d1e0f2bc"
down_revision = "f2b7c0d9e1ab"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("crm_item_companies") as b:
        b.add_column(sa.Column("short_name", sa.String(length=20), nullable=True))
        b.add_column(sa.Column("contacts", sa.JSON(), nullable=True))
        b.add_column(sa.Column("min_margin_pct", sa.Numeric(5, 2), nullable=True))
        b.add_column(sa.Column("expiry_receive_days", sa.Integer(), nullable=True))
        b.add_column(sa.Column("dump_days", sa.Integer(), nullable=True))
        b.add_column(sa.Column("website", sa.String(length=200), nullable=True))
        b.add_column(sa.Column("notes", sa.Text(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("crm_item_companies") as b:
        for col in ("notes", "website", "dump_days", "expiry_receive_days", "min_margin_pct", "contacts", "short_name"):
            b.drop_column(col)
