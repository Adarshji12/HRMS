"""Item rack

Revision ID: k7a2b5c4d6f0
Revises: j6f1a4b3c5ef
"""

import sqlalchemy as sa
from alembic import op

revision = "k7a2b5c4d6f0"
down_revision = "j6f1a4b3c5ef"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("erp_items") as b:
        b.add_column(sa.Column("rack", sa.String(length=120), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("erp_items") as b:
        b.drop_column("rack")
