"""purchase order line discount

Revision ID: b9e5d1f7c364
Revises: a7d3c9e5f128
Create Date: 2026-10-31 12:00:00.000000

A trade discount per PO line, off before GST. Goods received are valued at the
rate net of it.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'b9e5d1f7c364'
down_revision: Union[str, None] = 'a7d3c9e5f128'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('erp_purchase_order_lines') as batch:
        batch.add_column(sa.Column('discount_percent', sa.Numeric(5, 2), nullable=False, server_default='0'))


def downgrade() -> None:
    with op.batch_alter_table('erp_purchase_order_lines') as batch:
        batch.drop_column('discount_percent')
