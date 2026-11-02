"""sales order: the fields a full order carries

Revision ID: e8c2f6a4d935
Revises: d5a9e3b7f621
Create Date: 2026-11-02 10:00:00.000000

Salesperson, order type, priority and an internal reference; delivery terms,
mode, transporter, freight terms and instructions; freight and other charges
with the CGST / SGST / IGST split; terms, internal notes and attachments; and
a discount on each line. Orders already saved get their tax split from the
tax they carry.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'e8c2f6a4d935'
down_revision: Union[str, None] = 'd5a9e3b7f621'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

MONEY_COLS = ('freight', 'other_charges', 'cgst', 'sgst', 'igst')


def upgrade() -> None:
    with op.batch_alter_table('erp_sales_orders') as batch:
        batch.add_column(sa.Column('salesperson_id', sa.Uuid(), nullable=True))
        batch.create_foreign_key('fk_erp_sales_orders_salesperson', 'users', ['salesperson_id'], ['id'], ondelete='SET NULL')
        batch.add_column(sa.Column('order_type', sa.String(length=20), nullable=False, server_default='standard'))
        batch.add_column(sa.Column('priority', sa.String(length=10), nullable=False, server_default='normal'))
        batch.add_column(sa.Column('reference', sa.String(length=80), nullable=True))
        batch.add_column(sa.Column('delivery_terms', sa.String(length=160), nullable=True))
        batch.add_column(sa.Column('delivery_mode', sa.String(length=20), nullable=True))
        batch.add_column(sa.Column('transporter_name', sa.String(length=120), nullable=True))
        batch.add_column(sa.Column('freight_terms', sa.String(length=20), nullable=True))
        batch.add_column(sa.Column('delivery_instructions', sa.Text(), nullable=True))
        batch.add_column(sa.Column('terms', sa.Text(), nullable=True))
        batch.add_column(sa.Column('internal_notes', sa.Text(), nullable=True))
        batch.add_column(sa.Column('attachments', sa.JSON(), nullable=True))
        for name in MONEY_COLS:
            batch.add_column(sa.Column(name, sa.Numeric(14, 2), nullable=False, server_default='0'))
    with op.batch_alter_table('erp_sales_order_lines') as batch:
        batch.add_column(sa.Column('discount_percent', sa.Numeric(5, 2), nullable=False, server_default='0'))
    op.execute("UPDATE erp_sales_orders SET igst = tax_total WHERE is_interstate")
    op.execute("UPDATE erp_sales_orders SET cgst = ROUND(tax_total / 2, 2) WHERE NOT is_interstate")
    op.execute("UPDATE erp_sales_orders SET sgst = tax_total - cgst WHERE NOT is_interstate")


def downgrade() -> None:
    with op.batch_alter_table('erp_sales_order_lines') as batch:
        batch.drop_column('discount_percent')
    with op.batch_alter_table('erp_sales_orders') as batch:
        for name in MONEY_COLS:
            batch.drop_column(name)
        for name in ('attachments', 'internal_notes', 'terms', 'delivery_instructions', 'freight_terms',
                     'transporter_name', 'delivery_mode', 'delivery_terms', 'reference', 'priority', 'order_type'):
            batch.drop_column(name)
        batch.drop_constraint('fk_erp_sales_orders_salesperson', type_='foreignkey')
        batch.drop_column('salesperson_id')
