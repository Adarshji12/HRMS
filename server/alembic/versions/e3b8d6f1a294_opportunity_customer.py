"""Opportunity: the customer it is for.

Revision ID: e3b8d6f1a294
Revises: d2a7c5e9b183
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "e3b8d6f1a294"
down_revision: Union[str, None] = "d2a7c5e9b183"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("crm_opportunities") as batch:
        batch.add_column(sa.Column("customer_id", sa.Uuid(), nullable=True))
        batch.create_foreign_key(
            "fk_crm_opportunities_customer_id", "crm_customers", ["customer_id"], ["id"],
            ondelete="SET NULL",
        )


def downgrade() -> None:
    with op.batch_alter_table("crm_opportunities") as batch:
        batch.drop_constraint("fk_crm_opportunities_customer_id", type_="foreignkey")
        batch.drop_column("customer_id")
