"""invoice customer PO, reverse charge, transport details

Revision ID: b4e8c2d6f513
Revises: a1d5f9b3c742
Create Date: 2026-10-30 12:00:00.000000

What a GST tax invoice for goods usually carries besides the lines: the
customer's PO reference, whether tax is payable on reverse charge, and the
transport — dispatch document, transporter, vehicle, e-way bill and LR.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'b4e8c2d6f513'
down_revision: Union[str, None] = 'a1d5f9b3c742'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

COLUMNS = (
    ('customer_po_number', sa.String(60)),
    ('dispatch_doc_number', sa.String(40)),
    ('transporter_name', sa.String(120)),
    ('vehicle_number', sa.String(20)),
    ('eway_bill_number', sa.String(12)),
    ('lr_number', sa.String(40)),
)


def upgrade() -> None:
    with op.batch_alter_table('erp_invoices') as batch:
        for name, kind in COLUMNS:
            batch.add_column(sa.Column(name, kind, nullable=True))
        batch.add_column(sa.Column('reverse_charge', sa.Boolean(), nullable=False, server_default=sa.false()))


def downgrade() -> None:
    with op.batch_alter_table('erp_invoices') as batch:
        batch.drop_column('reverse_charge')
        for name, _ in reversed(COLUMNS):
            batch.drop_column(name)
