"""City pincode

Revision ID: b7c2d5e4f6b6
Revises: a6b1c4d3e5a5
"""

import sqlalchemy as sa
from alembic import op

revision = "b7c2d5e4f6b6"
down_revision = "a6b1c4d3e5a5"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("crm_cities") as b:
        b.add_column(sa.Column("pincode", sa.String(length=12), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("crm_cities") as b:
        b.drop_column("pincode")
