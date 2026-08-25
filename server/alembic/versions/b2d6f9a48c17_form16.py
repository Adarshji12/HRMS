"""Payroll checkpoint 4b: Form 16 Part B

Revision ID: b2d6f9a48c17
Revises: a1c5e8f79b36
Create Date: 2026-08-24 14:20:00.000000

One table, and every figure on it is a **frozen snapshot**. A Form 16 is a
statement the employer signed and the employee filed a return against; it has to
say the same thing in three years, after the salary structure has been revised,
after the declaration was reopened, after the slab table gained a new year.
Recomputing it on read would quietly change a document somebody has already
filed. Same rule as timesheet approvals, issued letters, salary structures and
payslips.

Unique on `(user_id, financial_year, revision)`, not on the year alone: a
corrected certificate is a **revision** with its own reference number rather than
an edit, because somebody may already have filed against the first one. The
superseded row stays readable for the same reason.

`employee_pan_masked` stores the masked PAN only. The full number lives encrypted
on the profile and is revealed through Core HR's audited path; storing a second
plaintext copy here would defeat the encryption the profile bothers with.

Part A is deliberately absent — it is TRACES-generated against the employer's TAN
and downloaded from the income-tax portal. Producing something that looked like it
would let an employee file against a document no tax authority has seen.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'b2d6f9a48c17'
down_revision: Union[str, None] = 'a1c5e8f79b36'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'form16s',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('org_id', sa.Uuid(), nullable=False),
        sa.Column('user_id', sa.Uuid(), nullable=False),
        sa.Column('financial_year', sa.Integer(), nullable=False),
        sa.Column('revision', sa.Integer(), nullable=False, server_default='1'),
        sa.Column('reference_no', sa.String(length=60), nullable=False),
        sa.Column('status', sa.String(length=12), nullable=False,
                  server_default='issued'),

        # The frozen figures.
        sa.Column('gross_salary', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('standard_deduction', sa.Integer(), nullable=False,
                  server_default='0'),
        sa.Column('professional_tax', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('chapter_via', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('taxable_income', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('tax_before_rebate', sa.Integer(), nullable=False,
                  server_default='0'),
        sa.Column('rebate', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('surcharge', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('cess', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('total_tax', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('tds_deducted', sa.Integer(), nullable=False, server_default='0'),
        # Positive: still owed. Negative: over-deducted.
        sa.Column('balance', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('employer_pf', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('employee_pf', sa.Integer(), nullable=False, server_default='0'),

        sa.Column('regime', sa.String(length=8), nullable=False),
        sa.Column('age_band', sa.String(length=16), nullable=False,
                  server_default='below_60'),
        sa.Column('months_covered', sa.Integer(), nullable=False, server_default='0'),

        sa.Column('employee_name', sa.String(length=200), nullable=True),
        # Masked only — the full PAN stays encrypted on the profile.
        sa.Column('employee_pan_masked', sa.String(length=32), nullable=True),
        sa.Column('designation', sa.String(length=160), nullable=True),
        sa.Column('employer_name', sa.String(length=255), nullable=True),

        sa.Column('issued_on', sa.Date(), nullable=False),
        sa.Column('issued_by', sa.Uuid(), nullable=True),
        sa.Column('document_id', sa.Uuid(), nullable=True),
        sa.Column('note', sa.Text(), nullable=True),

        sa.Column('created_at', sa.DateTime(timezone=True),
                  server_default=sa.text('CURRENT_TIMESTAMP'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True),
                  server_default=sa.text('CURRENT_TIMESTAMP'), nullable=False),

        sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['issued_by'], ['users.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['document_id'], ['employee_documents.id'],
                                ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('user_id', 'financial_year', 'revision',
                            name='uq_form16_year_revision'),
        sa.UniqueConstraint('org_id', 'reference_no', name='uq_form16_reference'),
        sa.CheckConstraint('financial_year BETWEEN 2000 AND 2100',
                           name='ck_form16_year'),
        sa.CheckConstraint('revision >= 1', name='ck_form16_revision'),
    )
    op.create_index('ix_form16s_org_id', 'form16s', ['org_id'])
    op.create_index('ix_form16s_user_id', 'form16s', ['user_id'])
    op.create_index('ix_form16_org_year', 'form16s',
                    ['org_id', 'financial_year', 'status'])


def downgrade() -> None:
    op.drop_index('ix_form16_org_year', table_name='form16s')
    op.drop_index('ix_form16s_user_id', table_name='form16s')
    op.drop_index('ix_form16s_org_id', table_name='form16s')
    op.drop_table('form16s')
