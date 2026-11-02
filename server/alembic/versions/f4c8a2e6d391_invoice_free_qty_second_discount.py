"""invoice line free quantity and second discount

Revision ID: f4c8a2e6d391
Revises: e9a3c7f1b268
Create Date: 2026-10-30 12:00:00.000000

A sale bill line can carry free units (given, not charged) and a second
discount (% or ₹) that comes off after the first.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'f4c8a2e6d391'
down_revision: Union[str, None] = 'e9a3c7f1b268'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('erp_invoice_lines') as batch:
        batch.add_column(sa.Column('free_qty', sa.Numeric(14, 3), nullable=False, server_default='0'))
        batch.add_column(sa.Column('discount2_percent', sa.Numeric(5, 2), nullable=False, server_default='0'))
        batch.add_column(sa.Column('discount2_amount', sa.Numeric(14, 2), nullable=False, server_default='0'))


def downgrade() -> None:
    with op.batch_alter_table('erp_invoice_lines') as batch:
        for column in ('discount2_amount', 'discount2_percent', 'free_qty'):
            batch.drop_column(column)
