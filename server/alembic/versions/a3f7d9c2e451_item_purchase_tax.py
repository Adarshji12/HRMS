"""item purchase tax

Revision ID: a3f7d9c2e451
Revises: e7c4b2f9a618
Create Date: 2026-10-29 16:00:00.000000

A separate GST rate for purchases. ``gst_percent`` stays the sales tax; the new
column is what a purchase order line defaults to. Existing items start with the
two equal, which is what they were in effect until now.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'a3f7d9c2e451'
down_revision: Union[str, None] = 'e7c4b2f9a618'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('erp_items') as batch:
        batch.add_column(sa.Column('purchase_gst_percent', sa.Numeric(5, 2), nullable=False, server_default='18'))
    op.execute('UPDATE erp_items SET purchase_gst_percent = gst_percent')


def downgrade() -> None:
    with op.batch_alter_table('erp_items') as batch:
        batch.drop_column('purchase_gst_percent')
