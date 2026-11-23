"""vendor city and pincode

Revision ID: y4e9f2b1c383
Revises: x3d8e1a0b272
"""
from alembic import op
import sqlalchemy as sa

revision = "y4e9f2b1c383"
down_revision = "x3d8e1a0b272"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("erp_vendors") as b:
        b.add_column(sa.Column("city", sa.String(length=120), nullable=True))
        b.add_column(sa.Column("pincode", sa.String(length=12), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("erp_vendors") as b:
        b.drop_column("pincode")
        b.drop_column("city")
