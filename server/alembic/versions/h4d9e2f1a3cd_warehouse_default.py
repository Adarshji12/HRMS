"""Warehouse default flag

Revision ID: h4d9e2f1a3cd
Revises: g3c8d1e0f2bc
"""

import sqlalchemy as sa
from alembic import op

revision = "h4d9e2f1a3cd"
down_revision = "g3c8d1e0f2bc"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("erp_warehouses") as b:
        b.add_column(sa.Column("is_default", sa.Boolean(), nullable=False, server_default=sa.false()))


def downgrade() -> None:
    with op.batch_alter_table("erp_warehouses") as b:
        b.drop_column("is_default")
