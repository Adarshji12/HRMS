"""Country master: mobile number length.

Revision ID: b7d2f4a91c38
Revises: a8c3e5f71d29
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "b7d2f4a91c38"
down_revision: Union[str, None] = "a8c3e5f71d29"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("crm_countries") as batch:
        batch.add_column(sa.Column("mobile_length", sa.Integer(), server_default="10", nullable=False))


def downgrade() -> None:
    with op.batch_alter_table("crm_countries") as batch:
        batch.drop_column("mobile_length")
