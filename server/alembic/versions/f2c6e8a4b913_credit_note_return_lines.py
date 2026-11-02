"""credit note return lines: which invoice line a credit note line returns

Revision ID: f2c6e8a4b913
Revises: e5b9d3f7a246
Create Date: 2026-10-30 21:00:00.000000

A credit note for returned goods credits lines of the original invoice. Each
credit line now points at the invoice line it returns, so the quantity still
returnable is known and never over-credited.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'f2c6e8a4b913'
down_revision: Union[str, None] = 'e5b9d3f7a246'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('erp_invoice_lines') as batch:
        batch.add_column(sa.Column('source_line_id', sa.Uuid(), nullable=True))
        batch.create_foreign_key('fk_erp_invoice_lines_source_line', 'erp_invoice_lines', ['source_line_id'], ['id'],
                                 ondelete='SET NULL')
        batch.create_index('ix_erp_invoice_lines_source_line_id', ['source_line_id'])


def downgrade() -> None:
    with op.batch_alter_table('erp_invoice_lines') as batch:
        batch.drop_index('ix_erp_invoice_lines_source_line_id')
        batch.drop_constraint('fk_erp_invoice_lines_source_line', type_='foreignkey')
        batch.drop_column('source_line_id')
