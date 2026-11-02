"""invoice bill discount amount, additional discount and its reason

Revision ID: c7f3a9d5e284
Revises: b4e8c2d6f513
Create Date: 2026-10-30 15:00:00.000000

Beside the bill discount percentage: a bill discount in rupees, and an
additional discount with the reason for it. Both come off the item lines before
GST, shared out in proportion to each line's value.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'c7f3a9d5e284'
down_revision: Union[str, None] = 'b4e8c2d6f513'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('erp_invoices') as batch:
        batch.add_column(sa.Column('bill_discount_amount', sa.Numeric(14, 2), nullable=False, server_default='0'))
        batch.add_column(sa.Column('additional_discount', sa.Numeric(14, 2), nullable=False, server_default='0'))
        batch.add_column(sa.Column('discount_reason', sa.String(200), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('erp_invoices') as batch:
        batch.drop_column('discount_reason')
        batch.drop_column('additional_discount')
        batch.drop_column('bill_discount_amount')
