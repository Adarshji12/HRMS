"""sales order: GST on freight and other charges

Revision ID: f3d7b1e9a428
Revises: e8c2f6a4d935
Create Date: 2026-11-02 15:00:00.000000

Freight and other charges on a sales order are part of the taxable value and
carry GST — by default at the highest rate on the order's items. The rate used
is kept on the order.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'f3d7b1e9a428'
down_revision: Union[str, None] = 'e8c2f6a4d935'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('erp_sales_orders') as batch:
        batch.add_column(sa.Column('charges_gst_percent', sa.Numeric(5, 2), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('erp_sales_orders') as batch:
        batch.drop_column('charges_gst_percent')
