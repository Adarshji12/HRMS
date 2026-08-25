"""Payroll checkpoint 1: pay components and salary structures

Revision ID: d7f2b5c46e03
Revises: c6e1a4b35d92
Create Date: 2026-08-24 08:30:00.000000

Three new tables and one additive column on `users`.

All money is integer paise and every amount is monthly.

`salary_structure_components.component_id` is RESTRICT: a component that has ever
appeared on somebody's structure is part of their pay history, so it cannot be
deleted — deactivating retires one. Every other FK follows the house pattern.

**`users.can_manage_payroll` defaults to FALSE, and that breaks the convention
every other permission flag in this table follows.** The others default true
because they restrict a capability that already existed, and defaulting false
would take something away from people who had it. There is no existing payroll
capability to preserve, and defaulting true would grant every administrator
visibility of every salary the moment this migration runs — which is the exact
outcome the restrict-only convention exists to prevent, arriving from the other
direction. The account owner is treated as always holding it (see
`services/payroll.can_manage`), so the workspace is never locked out of its own
payroll and can grant the flag to whoever should have it.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'd7f2b5c46e03'
down_revision: Union[str, None] = 'c6e1a4b35d92'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'pay_components',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('org_id', sa.Uuid(), nullable=False),
        sa.Column('code', sa.String(length=24), nullable=False),
        sa.Column('name', sa.String(length=120), nullable=False),
        sa.Column('kind', sa.String(length=12), nullable=False, server_default='earning'),
        sa.Column('calculation', sa.String(length=20), nullable=False,
                  server_default='fixed'),
        sa.Column('rate_bps', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('is_basic', sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column('is_pf_wage', sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column('is_esi_wage', sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column('is_taxable', sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column('sort_order', sa.Integer(), nullable=False, server_default='100'),
        sa.Column('is_active', sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column('description', sa.String(length=400), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True),
                  server_default=sa.text('CURRENT_TIMESTAMP'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True),
                  server_default=sa.text('CURRENT_TIMESTAMP'), nullable=False),
        sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('org_id', 'code', name='uq_pay_components_code'),
        sa.CheckConstraint('rate_bps >= 0 AND rate_bps <= 1000000',
                           name='ck_pay_components_rate'),
    )
    op.create_index('ix_pay_components_org_id', 'pay_components', ['org_id'])
    op.create_index('ix_pay_components_org_kind', 'pay_components', ['org_id', 'kind'])

    op.create_table(
        'salary_structures',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('org_id', sa.Uuid(), nullable=False),
        sa.Column('user_id', sa.Uuid(), nullable=False),
        sa.Column('effective_from', sa.Date(), nullable=False),
        sa.Column('effective_to', sa.Date(), nullable=True),
        sa.Column('gross_monthly', sa.Integer(), nullable=False),
        sa.Column('reason', sa.Text(), nullable=True),
        sa.Column('created_by', sa.Uuid(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True),
                  server_default=sa.text('CURRENT_TIMESTAMP'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True),
                  server_default=sa.text('CURRENT_TIMESTAMP'), nullable=False),
        sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['created_by'], ['users.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('user_id', 'effective_from',
                            name='uq_salary_structures_effective'),
        sa.CheckConstraint('gross_monthly > 0',
                           name='ck_salary_structures_gross_positive'),
    )
    op.create_index('ix_salary_structures_org_id', 'salary_structures', ['org_id'])
    op.create_index('ix_salary_structures_user_id', 'salary_structures', ['user_id'])
    op.create_index('ix_salary_structures_user', 'salary_structures',
                    ['org_id', 'user_id', 'effective_from'])
    op.create_index('ix_salary_structures_current', 'salary_structures',
                    ['org_id', 'effective_to'])

    op.create_table(
        'salary_structure_components',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('org_id', sa.Uuid(), nullable=False),
        sa.Column('structure_id', sa.Uuid(), nullable=False),
        sa.Column('component_id', sa.Uuid(), nullable=False),
        sa.Column('amount', sa.Integer(), nullable=False),
        # The catalogue entry as it was, so a reprinted payslip explains itself
        # the way it did at the time.
        sa.Column('code', sa.String(length=24), nullable=False),
        sa.Column('name', sa.String(length=120), nullable=False),
        sa.Column('kind', sa.String(length=12), nullable=False),
        sa.Column('calculation', sa.String(length=20), nullable=False),
        sa.Column('rate_bps', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('is_pf_wage', sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column('is_esi_wage', sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column('is_taxable', sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column('sort_order', sa.Integer(), nullable=False, server_default='100'),
        sa.Column('created_at', sa.DateTime(timezone=True),
                  server_default=sa.text('CURRENT_TIMESTAMP'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True),
                  server_default=sa.text('CURRENT_TIMESTAMP'), nullable=False),
        sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['structure_id'], ['salary_structures.id'],
                                ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['component_id'], ['pay_components.id'],
                                ondelete='RESTRICT'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('structure_id', 'component_id',
                            name='uq_salary_structure_components'),
        sa.CheckConstraint('amount >= 0', name='ck_salary_structure_components_amount'),
    )
    op.create_index('ix_salary_structure_components_org_id',
                    'salary_structure_components', ['org_id'])
    op.create_index('ix_salary_structure_components_structure',
                    'salary_structure_components', ['structure_id'])

    with op.batch_alter_table('users', schema=None) as batch_op:
        batch_op.add_column(
            # False, deliberately. See the module docstring.
            sa.Column('can_manage_payroll', sa.Boolean(), nullable=False,
                      server_default=sa.false())
        )


def downgrade() -> None:
    with op.batch_alter_table('users', schema=None) as batch_op:
        batch_op.drop_column('can_manage_payroll')

    op.drop_index('ix_salary_structure_components_structure',
                  table_name='salary_structure_components')
    op.drop_index('ix_salary_structure_components_org_id',
                  table_name='salary_structure_components')
    op.drop_table('salary_structure_components')

    op.drop_index('ix_salary_structures_current', table_name='salary_structures')
    op.drop_index('ix_salary_structures_user', table_name='salary_structures')
    op.drop_index('ix_salary_structures_user_id', table_name='salary_structures')
    op.drop_index('ix_salary_structures_org_id', table_name='salary_structures')
    op.drop_table('salary_structures')

    op.drop_index('ix_pay_components_org_kind', table_name='pay_components')
    op.drop_index('ix_pay_components_org_id', table_name='pay_components')
    op.drop_table('pay_components')
