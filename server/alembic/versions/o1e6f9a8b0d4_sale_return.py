"""ERP sale returns share the sale-bill tables

Revision ID: o1e6f9a8b0d4
Revises: n0d5e8f7a9c3
"""

import sqlalchemy as sa
from alembic import op

revision = "o1e6f9a8b0d4"
down_revision = "n0d5e8f7a9c3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("erp_sale_bills") as batch:
        batch.add_column(sa.Column("against_number", sa.String(length=40), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("erp_sale_bills") as batch:
        batch.drop_column("against_number")
