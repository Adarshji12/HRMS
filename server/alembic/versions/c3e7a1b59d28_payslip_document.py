"""Payroll checkpoint 5: the filed payslip

Revision ID: c3e7a1b59d28
Revises: b2d6f9a48c17
Create Date: 2026-08-24 16:00:00.000000

One additive column: `payslips.document_id`.

A payslip has been re-renderable from its own frozen lines since checkpoint 2,
which is enough to *show* it. It is not enough to have it: an employee applying
for a mortgage three years after leaving needs the document, and re-rendering
depends on this system still running and still holding their account. Filing a
copy into `employee_documents` puts it where every other personal document of
theirs lives.

SET NULL rather than CASCADE: deleting the filed copy must not delete the payslip
it was rendered from. The payslip's own lines remain the record.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'c3e7a1b59d28'
down_revision: Union[str, None] = 'b2d6f9a48c17'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('payslips', schema=None) as batch_op:
        batch_op.add_column(sa.Column('document_id', sa.Uuid(), nullable=True))
        batch_op.create_foreign_key(
            'fk_payslips_document', 'employee_documents',
            ['document_id'], ['id'], ondelete='SET NULL',
        )


def downgrade() -> None:
    with op.batch_alter_table('payslips', schema=None) as batch_op:
        batch_op.drop_constraint('fk_payslips_document', type_='foreignkey')
        batch_op.drop_column('document_id')
