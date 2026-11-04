"""Opportunity: costsheet approval becomes a status (pending / approved / rejected).

Revision ID: f4c9e7a2b315
Revises: e3b8d6f1a294
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "f4c9e7a2b315"
down_revision: Union[str, None] = "e3b8d6f1a294"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("crm_opportunities") as batch:
        batch.add_column(sa.Column("costsheet_status", sa.String(length=10), server_default="none", nullable=False))
    # What was ticked under the old flag was an approval, so it stays one.
    op.execute("UPDATE crm_opportunities SET costsheet_status = 'approved' WHERE costsheet_approved")
    with op.batch_alter_table("crm_opportunities") as batch:
        batch.drop_column("costsheet_approved")


def downgrade() -> None:
    with op.batch_alter_table("crm_opportunities") as batch:
        batch.add_column(sa.Column("costsheet_approved", sa.Boolean(), server_default="0", nullable=False))
    op.execute("UPDATE crm_opportunities SET costsheet_approved = 1 WHERE costsheet_status = 'approved'")
    with op.batch_alter_table("crm_opportunities") as batch:
        batch.drop_column("costsheet_status")
