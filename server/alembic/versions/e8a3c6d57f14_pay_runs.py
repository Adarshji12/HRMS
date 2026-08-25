"""Payroll checkpoint 2: pay runs, payslips and payslip lines

Revision ID: e8a3c6d57f14
Revises: d7f2b5c46e03
Create Date: 2026-08-24 09:40:00.000000

Three new tables. All money is integer paise.

`pay_runs` is unique on `(org_id, period_year, period_month)`. Two runs for one
month is not a scenario anybody wants — it is what a double-click produces, and
the second set of payslips cannot be reconciled against the first.

`payslips.structure_id` is SET NULL, not RESTRICT. The payslip's own lines are
the durable record of what was paid; the pointer only answers "which revision
was this", and a structure deleted years later must not take a payslip with it.

`payslip_lines.source_id` is deliberately an untyped Uuid with no foreign key.
It points into whichever table `source` names — a loan instalment, an expense
claim, a pay component. A real FK would need one nullable column per source and
a migration for every new one; the `source` column beside it says where to look.

Amounts on lines are always **positive**, with `kind` deciding the sign. A signed
column means every sum has to remember which convention it is in, and eventually
one of them does not.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'e8a3c6d57f14'
down_revision: Union[str, None] = 'd7f2b5c46e03'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'pay_runs',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('org_id', sa.Uuid(), nullable=False),
        sa.Column('period_year', sa.Integer(), nullable=False),
        sa.Column('period_month', sa.Integer(), nullable=False),
        sa.Column('status', sa.String(length=12), nullable=False, server_default='draft'),
        sa.Column('pay_date', sa.Date(), nullable=True),
        sa.Column('total_gross', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('total_deductions', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('total_net', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('employee_count', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('computed_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('computed_by', sa.Uuid(), nullable=True),
        sa.Column('approved_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('approved_by', sa.Uuid(), nullable=True),
        sa.Column('paid_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('paid_by', sa.Uuid(), nullable=True),
        sa.Column('payment_reference', sa.String(length=120), nullable=True),
        sa.Column('notes', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True),
                  server_default=sa.text('CURRENT_TIMESTAMP'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True),
                  server_default=sa.text('CURRENT_TIMESTAMP'), nullable=False),
        sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['computed_by'], ['users.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['approved_by'], ['users.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['paid_by'], ['users.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('org_id', 'period_year', 'period_month',
                            name='uq_pay_runs_period'),
        sa.CheckConstraint('period_month >= 1 AND period_month <= 12',
                           name='ck_pay_runs_month'),
        sa.CheckConstraint('period_year >= 2000 AND period_year <= 2100',
                           name='ck_pay_runs_year'),
    )
    op.create_index('ix_pay_runs_org_id', 'pay_runs', ['org_id'])
    op.create_index('ix_pay_runs_org_status', 'pay_runs', ['org_id', 'status'])

    op.create_table(
        'payslips',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('org_id', sa.Uuid(), nullable=False),
        sa.Column('run_id', sa.Uuid(), nullable=False),
        sa.Column('user_id', sa.Uuid(), nullable=False),
        sa.Column('structure_id', sa.Uuid(), nullable=True),
        sa.Column('lop_milli_days', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('month_days', sa.Integer(), nullable=False, server_default='30'),
        sa.Column('payable_days', sa.Integer(), nullable=False, server_default='30'),
        sa.Column('gross', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('total_deductions', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('net', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('full_gross', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('note', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True),
                  server_default=sa.text('CURRENT_TIMESTAMP'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True),
                  server_default=sa.text('CURRENT_TIMESTAMP'), nullable=False),
        sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['run_id'], ['pay_runs.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['structure_id'], ['salary_structures.id'],
                                ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('run_id', 'user_id', name='uq_payslips_run_user'),
        sa.CheckConstraint('payable_days >= 0', name='ck_payslips_payable_days'),
    )
    op.create_index('ix_payslips_org_id', 'payslips', ['org_id'])
    op.create_index('ix_payslips_run_id', 'payslips', ['run_id'])
    op.create_index('ix_payslips_user_id', 'payslips', ['user_id'])
    op.create_index('ix_payslips_user', 'payslips', ['org_id', 'user_id'])

    op.create_table(
        'payslip_lines',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('org_id', sa.Uuid(), nullable=False),
        sa.Column('payslip_id', sa.Uuid(), nullable=False),
        sa.Column('kind', sa.String(length=12), nullable=False),
        sa.Column('code', sa.String(length=32), nullable=False),
        sa.Column('name', sa.String(length=160), nullable=False),
        sa.Column('amount', sa.Integer(), nullable=False),
        sa.Column('source', sa.String(length=20), nullable=False,
                  server_default='structure'),
        # No FK: it points into whichever table `source` names.
        sa.Column('source_id', sa.Uuid(), nullable=True),
        sa.Column('detail', sa.String(length=300), nullable=True),
        sa.Column('sort_order', sa.Integer(), nullable=False, server_default='100'),
        sa.Column('created_at', sa.DateTime(timezone=True),
                  server_default=sa.text('CURRENT_TIMESTAMP'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True),
                  server_default=sa.text('CURRENT_TIMESTAMP'), nullable=False),
        sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['payslip_id'], ['payslips.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.CheckConstraint('amount >= 0', name='ck_payslip_lines_amount'),
    )
    op.create_index('ix_payslip_lines_org_id', 'payslip_lines', ['org_id'])
    op.create_index('ix_payslip_lines_payslip', 'payslip_lines', ['payslip_id'])
    # "What did this loan instalment get deducted on" — reachable from the line.
    op.create_index('ix_payslip_lines_source', 'payslip_lines',
                    ['org_id', 'source', 'source_id'])


def downgrade() -> None:
    op.drop_index('ix_payslip_lines_source', table_name='payslip_lines')
    op.drop_index('ix_payslip_lines_payslip', table_name='payslip_lines')
    op.drop_index('ix_payslip_lines_org_id', table_name='payslip_lines')
    op.drop_table('payslip_lines')

    op.drop_index('ix_payslips_user', table_name='payslips')
    op.drop_index('ix_payslips_user_id', table_name='payslips')
    op.drop_index('ix_payslips_run_id', table_name='payslips')
    op.drop_index('ix_payslips_org_id', table_name='payslips')
    op.drop_table('payslips')

    op.drop_index('ix_pay_runs_org_status', table_name='pay_runs')
    op.drop_index('ix_pay_runs_org_id', table_name='pay_runs')
    op.drop_table('pay_runs')
