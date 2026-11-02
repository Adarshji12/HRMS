"""Plan master: code, billing cycle and description.

Revision ID: a8c3e5f71d29
Revises: f3d7b1e9a428
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "a8c3e5f71d29"
down_revision: Union[str, None] = "f3d7b1e9a428"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("crm_plans") as batch:
        batch.add_column(sa.Column("code", sa.String(length=40), nullable=True))
        batch.add_column(sa.Column("billing_cycle", sa.String(length=20), server_default="yearly", nullable=False))
        batch.add_column(sa.Column("description", sa.Text(), nullable=True))
    # A plan saved without a duration meant "no renewal"; keep it that way
    # rather than letting the new yearly default start renewing it.
    op.execute("UPDATE crm_plans SET billing_cycle = 'one_time' WHERE duration_days IS NULL")


def downgrade() -> None:
    with op.batch_alter_table("crm_plans") as batch:
        batch.drop_column("description")
        batch.drop_column("billing_cycle")
        batch.drop_column("code")
