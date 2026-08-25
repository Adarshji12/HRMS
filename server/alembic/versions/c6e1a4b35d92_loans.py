"""Loans and advances: agreements and instalment schedules

Revision ID: c6e1a4b35d92
Revises: b5d9f3a24c81
Create Date: 2026-08-24 07:15:00.000000

Two new tables and two additive columns on `users`.

All money is integer paise. `interest_rate_bps` is basis points as an integer —
1200 is 12% — so a rate never picks up a floating-point error on its way into an
interest calculation.

`loan_instalments` has a unique constraint on `(loan_id, sequence)`. That is the
important one: without it, a schedule regenerated after a partial repayment
silently doubles the loan's obligations, and the balance would then be wrong in
the direction nobody checks.

There is deliberately **no** stored outstanding balance. It is the sum of the
unpaid instalments, and a stored copy is a second number to drift from the rows
it summarises. This is the opposite of `expense_claims.total_amount`, which is
stored because approval freezes it — an outstanding balance is supposed to move
every time an instalment is paid.

Four check constraints, all for states no code path should be able to produce: a
non-positive principal or instalment amount, a zero-or-absurd instalment count,
and an interest rate outside 0–100%.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'c6e1a4b35d92'
down_revision: Union[str, None] = 'b5d9f3a24c81'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'loans',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('org_id', sa.Uuid(), nullable=False),
        sa.Column('user_id', sa.Uuid(), nullable=False),
        sa.Column('created_by_user_id', sa.Uuid(), nullable=True),
        sa.Column('loan_type', sa.String(length=24), nullable=False,
                  server_default='salary_advance'),
        sa.Column('principal', sa.Integer(), nullable=False),
        sa.Column('approved_principal', sa.Integer(), nullable=True),
        sa.Column('instalment_count', sa.Integer(), nullable=False),
        sa.Column('interest_rate_bps', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('purpose', sa.Text(), nullable=True),
        sa.Column('status', sa.String(length=16), nullable=False,
                  server_default='requested'),
        sa.Column('requested_on', sa.Date(), nullable=False),
        sa.Column('reviewed_by', sa.Uuid(), nullable=True),
        sa.Column('reviewed_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('review_note', sa.Text(), nullable=True),
        sa.Column('disbursed_on', sa.Date(), nullable=True),
        sa.Column('disbursed_by', sa.Uuid(), nullable=True),
        sa.Column('disbursement_reference', sa.String(length=120), nullable=True),
        sa.Column('closed_on', sa.Date(), nullable=True),
        sa.Column('closure_note', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True),
                  server_default=sa.text('CURRENT_TIMESTAMP'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True),
                  server_default=sa.text('CURRENT_TIMESTAMP'), nullable=False),
        sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['created_by_user_id'], ['users.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['reviewed_by'], ['users.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['disbursed_by'], ['users.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id'),
        sa.CheckConstraint('principal > 0', name='ck_loans_principal_positive'),
        sa.CheckConstraint('instalment_count > 0 AND instalment_count <= 120',
                           name='ck_loans_instalment_count'),
        sa.CheckConstraint('interest_rate_bps >= 0 AND interest_rate_bps <= 10000',
                           name='ck_loans_interest_rate'),
    )
    op.create_index('ix_loans_org_id', 'loans', ['org_id'])
    op.create_index('ix_loans_user_id', 'loans', ['user_id'])
    op.create_index('ix_loans_user', 'loans', ['org_id', 'user_id', 'status'])
    op.create_index('ix_loans_status', 'loans', ['org_id', 'status'])

    op.create_table(
        'loan_instalments',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('org_id', sa.Uuid(), nullable=False),
        sa.Column('loan_id', sa.Uuid(), nullable=False),
        sa.Column('sequence', sa.Integer(), nullable=False),
        sa.Column('due_on', sa.Date(), nullable=False),
        sa.Column('amount', sa.Integer(), nullable=False),
        sa.Column('status', sa.String(length=12), nullable=False, server_default='pending'),
        sa.Column('paid_amount', sa.Integer(), nullable=True),
        sa.Column('paid_on', sa.Date(), nullable=True),
        sa.Column('recorded_by', sa.Uuid(), nullable=True),
        sa.Column('reference', sa.String(length=120), nullable=True),
        sa.Column('note', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True),
                  server_default=sa.text('CURRENT_TIMESTAMP'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True),
                  server_default=sa.text('CURRENT_TIMESTAMP'), nullable=False),
        sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['loan_id'], ['loans.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['recorded_by'], ['users.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id'),
        # The one that matters: a regenerated schedule must not be able to
        # double a loan's obligations.
        sa.UniqueConstraint('loan_id', 'sequence', name='uq_loan_instalments_sequence'),
        sa.CheckConstraint('amount > 0', name='ck_loan_instalments_amount_positive'),
        sa.CheckConstraint('sequence > 0', name='ck_loan_instalments_sequence_positive'),
    )
    op.create_index('ix_loan_instalments_org_id', 'loan_instalments', ['org_id'])
    op.create_index('ix_loan_instalments_loan_id', 'loan_instalments', ['loan_id'])
    op.create_index('ix_loan_instalments_due', 'loan_instalments',
                    ['org_id', 'due_on', 'status'])

    with op.batch_alter_table('users', schema=None) as batch_op:
        batch_op.add_column(
            sa.Column('can_approve_loans', sa.Boolean(), nullable=False,
                      server_default=sa.true())
        )
        batch_op.add_column(
            sa.Column('can_disburse_loans', sa.Boolean(), nullable=False,
                      server_default=sa.true())
        )


def downgrade() -> None:
    with op.batch_alter_table('users', schema=None) as batch_op:
        batch_op.drop_column('can_disburse_loans')
        batch_op.drop_column('can_approve_loans')

    op.drop_index('ix_loan_instalments_due', table_name='loan_instalments')
    op.drop_index('ix_loan_instalments_loan_id', table_name='loan_instalments')
    op.drop_index('ix_loan_instalments_org_id', table_name='loan_instalments')
    op.drop_table('loan_instalments')

    op.drop_index('ix_loans_status', table_name='loans')
    op.drop_index('ix_loans_user', table_name='loans')
    op.drop_index('ix_loans_user_id', table_name='loans')
    op.drop_index('ix_loans_org_id', table_name='loans')
    op.drop_table('loans')
