"""Opportunity: costsheet approved flag.

Revision ID: d2a7c5e9b183
Revises: c9f4b6d28e51
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "d2a7c5e9b183"
down_revision: Union[str, None] = "c9f4b6d28e51"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("crm_opportunities") as batch:
        batch.add_column(sa.Column("costsheet_approved", sa.Boolean(), server_default="0", nullable=False))


def downgrade() -> None:
    with op.batch_alter_table("crm_opportunities") as batch:
        batch.drop_column("costsheet_approved")
