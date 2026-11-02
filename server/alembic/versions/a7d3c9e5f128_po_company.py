"""purchase order company: the make / OEM the order is for

Revision ID: a7d3c9e5f128
Revises: f2c6e8a4b913
Create Date: 2026-10-31 10:00:00.000000

Picked from Master -> ERP Master -> Company Master; narrows the order's item
list to that company's products.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'a7d3c9e5f128'
down_revision: Union[str, None] = 'f2c6e8a4b913'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('erp_purchase_orders') as batch:
        batch.add_column(sa.Column('company', sa.String(length=120), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('erp_purchase_orders') as batch:
        batch.drop_column('company')
