"""Account group code and archive flag

Revision ID: c8d3e6f5a7c7
Revises: b7c2d5e4f6b6
"""

import sqlalchemy as sa
from alembic import op

revision = "c8d3e6f5a7c7"
down_revision = "b7c2d5e4f6b6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("erp_account_groups") as b:
        b.add_column(sa.Column("code", sa.String(length=16), nullable=True))
        b.add_column(sa.Column("is_archived", sa.Boolean(), nullable=False, server_default=sa.false()))


def downgrade() -> None:
    with op.batch_alter_table("erp_account_groups") as b:
        b.drop_column("is_archived")
        b.drop_column("code")
