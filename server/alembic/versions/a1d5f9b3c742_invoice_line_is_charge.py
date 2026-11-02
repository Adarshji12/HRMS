"""invoice line is_charge

Revision ID: a1d5f9b3c742
Revises: f4c8a2e6d391
Create Date: 2026-10-30 15:00:00.000000

Freight, packing and other charges are billed as lines. Marking them lets a
draft be edited back into the bill's charge boxes, and keeps the bill
discount off them when it is repriced.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'a1d5f9b3c742'
down_revision: Union[str, None] = 'f4c8a2e6d391'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('erp_invoice_lines') as batch:
        batch.add_column(sa.Column('is_charge', sa.Boolean(), nullable=False, server_default=sa.false()))


def downgrade() -> None:
    with op.batch_alter_table('erp_invoice_lines') as batch:
        batch.drop_column('is_charge')
