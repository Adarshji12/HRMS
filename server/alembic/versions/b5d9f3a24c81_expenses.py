"""Expense claims: categories, claims and lines

Revision ID: b5d9f3a24c81
Revises: a4c8e2f13b70
Create Date: 2026-08-24 06:20:00.000000

Three new tables and two additive columns on `users`.

All money is integer paise, matching billing and `app.core.plans`. Never a
float: a rounding error in a reimbursement is a support ticket from somebody who
was underpaid.

`expense_lines.category_id` is RESTRICT, not SET NULL. A line with no category
cannot be reported on or checked against a limit, so a category in use is not
deletable — deactivating it is how one is retired. Every other FK here follows
the house pattern: CASCADE from the tenant and the claim, SET NULL for the people
who acted.

Two check constraints, both worth having at the database rather than only in the
service: a negative claim total and a zero-amount line are both states no code
path should be able to produce, and a constraint is what makes that true of code
paths nobody has written yet.

`can_approve_expenses` and `can_reimburse_expenses` are separate flags because
they are different jobs: a manager says the spend was legitimate, finance says it
has been paid. Both default true, like every other flag in that set — they
restrict rather than grant.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'b5d9f3a24c81'
down_revision: Union[str, None] = 'a4c8e2f13b70'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'expense_categories',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('org_id', sa.Uuid(), nullable=False),
        sa.Column('name', sa.String(length=120), nullable=False),
        sa.Column('description', sa.String(length=400), nullable=True),
        sa.Column('requires_receipt', sa.Boolean(), nullable=False, server_default=sa.true()),
        # NULL means no ceiling. Not 0, which would refuse every claim.
        sa.Column('max_amount', sa.Integer(), nullable=True),
        sa.Column('is_active', sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column('created_at', sa.DateTime(timezone=True),
                  server_default=sa.text('CURRENT_TIMESTAMP'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True),
                  server_default=sa.text('CURRENT_TIMESTAMP'), nullable=False),
        sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('org_id', 'name', name='uq_expense_categories_name'),
    )
    op.create_index('ix_expense_categories_org_id', 'expense_categories', ['org_id'])

    op.create_table(
        'expense_claims',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('org_id', sa.Uuid(), nullable=False),
        sa.Column('user_id', sa.Uuid(), nullable=False),
        sa.Column('created_by_user_id', sa.Uuid(), nullable=True),
        sa.Column('title', sa.String(length=200), nullable=False),
        sa.Column('note', sa.Text(), nullable=True),
        sa.Column('project_id', sa.Uuid(), nullable=True),
        sa.Column('status', sa.String(length=16), nullable=False, server_default='draft'),
        sa.Column('total_amount', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('currency', sa.String(length=3), nullable=False, server_default='INR'),
        sa.Column('submitted_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('reviewed_by', sa.Uuid(), nullable=True),
        sa.Column('reviewed_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('review_note', sa.Text(), nullable=True),
        sa.Column('approved_amount', sa.Integer(), nullable=True),
        sa.Column('reimbursed_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('reimbursed_by', sa.Uuid(), nullable=True),
        sa.Column('payment_reference', sa.String(length=120), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True),
                  server_default=sa.text('CURRENT_TIMESTAMP'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True),
                  server_default=sa.text('CURRENT_TIMESTAMP'), nullable=False),
        sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['created_by_user_id'], ['users.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['reviewed_by'], ['users.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['reimbursed_by'], ['users.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id'),
        sa.CheckConstraint('total_amount >= 0', name='ck_expense_claims_total_nonneg'),
    )
    op.create_index('ix_expense_claims_org_id', 'expense_claims', ['org_id'])
    op.create_index('ix_expense_claims_user_id', 'expense_claims', ['user_id'])
    op.create_index('ix_expense_claims_user', 'expense_claims',
                    ['org_id', 'user_id', 'status'])
    op.create_index('ix_expense_claims_status', 'expense_claims', ['org_id', 'status'])

    op.create_table(
        'expense_lines',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('org_id', sa.Uuid(), nullable=False),
        sa.Column('claim_id', sa.Uuid(), nullable=False),
        sa.Column('category_id', sa.Uuid(), nullable=False),
        sa.Column('spent_on', sa.Date(), nullable=False),
        sa.Column('description', sa.String(length=300), nullable=False),
        sa.Column('merchant', sa.String(length=160), nullable=True),
        sa.Column('amount', sa.Integer(), nullable=False),
        sa.Column('receipt_key', sa.String(length=500), nullable=True),
        sa.Column('receipt_name', sa.String(length=255), nullable=True),
        sa.Column('receipt_type', sa.String(length=120), nullable=True),
        sa.Column('receipt_size', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('created_at', sa.DateTime(timezone=True),
                  server_default=sa.text('CURRENT_TIMESTAMP'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True),
                  server_default=sa.text('CURRENT_TIMESTAMP'), nullable=False),
        sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['claim_id'], ['expense_claims.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['category_id'], ['expense_categories.id'],
                                ondelete='RESTRICT'),
        sa.PrimaryKeyConstraint('id'),
        sa.CheckConstraint('amount > 0', name='ck_expense_lines_amount_positive'),
    )
    op.create_index('ix_expense_lines_org_id', 'expense_lines', ['org_id'])
    op.create_index('ix_expense_lines_claim', 'expense_lines', ['claim_id'])
    op.create_index('ix_expense_lines_category', 'expense_lines',
                    ['org_id', 'category_id'])

    with op.batch_alter_table('users', schema=None) as batch_op:
        batch_op.add_column(
            sa.Column('can_approve_expenses', sa.Boolean(), nullable=False,
                      server_default=sa.true())
        )
        batch_op.add_column(
            sa.Column('can_reimburse_expenses', sa.Boolean(), nullable=False,
                      server_default=sa.true())
        )


def downgrade() -> None:
    with op.batch_alter_table('users', schema=None) as batch_op:
        batch_op.drop_column('can_reimburse_expenses')
        batch_op.drop_column('can_approve_expenses')

    op.drop_index('ix_expense_lines_category', table_name='expense_lines')
    op.drop_index('ix_expense_lines_claim', table_name='expense_lines')
    op.drop_index('ix_expense_lines_org_id', table_name='expense_lines')
    op.drop_table('expense_lines')

    op.drop_index('ix_expense_claims_status', table_name='expense_claims')
    op.drop_index('ix_expense_claims_user', table_name='expense_claims')
    op.drop_index('ix_expense_claims_user_id', table_name='expense_claims')
    op.drop_index('ix_expense_claims_org_id', table_name='expense_claims')
    op.drop_table('expense_claims')

    op.drop_index('ix_expense_categories_org_id', table_name='expense_categories')
    op.drop_table('expense_categories')
