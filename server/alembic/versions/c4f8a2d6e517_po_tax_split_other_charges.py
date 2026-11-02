"""purchase order: other charges and the CGST / SGST / IGST split

Revision ID: c4f8a2d6e517
Revises: b9e5d1f7c364
Create Date: 2026-10-31 15:00:00.000000

Orders already saved get their split from the tax they carry: all IGST when
inter-state, else halved, SGST taking the odd paisa.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'c4f8a2d6e517'
down_revision: Union[str, None] = 'b9e5d1f7c364'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('erp_purchase_orders') as batch:
        for name in ('other_charges', 'cgst', 'sgst', 'igst'):
            batch.add_column(sa.Column(name, sa.Numeric(14, 2), nullable=False, server_default='0'))
    op.execute("UPDATE erp_purchase_orders SET igst = tax_total WHERE is_interstate")
    op.execute("UPDATE erp_purchase_orders SET cgst = ROUND(tax_total / 2, 2) WHERE NOT is_interstate")
    op.execute("UPDATE erp_purchase_orders SET sgst = tax_total - cgst WHERE NOT is_interstate")


def downgrade() -> None:
    with op.batch_alter_table('erp_purchase_orders') as batch:
        for name in ('igst', 'sgst', 'cgst', 'other_charges'):
            batch.drop_column(name)
