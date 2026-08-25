"""Payroll checkpoint 3: statutory configuration and employer contributions

Revision ID: f9b4d7e68a25
Revises: e8a3c6d57f14
Create Date: 2026-08-24 11:05:00.000000

Two new tables, two columns on `employee_profiles`, one on `payslips`.

All money is integer paise; all rates are integer basis points (1200 = 12%).

`statutory_configs` is unique per organisation — a second row would be two
answers to "what is our PF rate" and nothing in the computation could choose.
Defaults are the Indian statutory ones as they stand: 12% PF each side of which
8.33% is pension, a ₹15,000 PF wage ceiling, ESI at 0.75%/3.25% below ₹21,000.
Every one of them lives in a column rather than in code, because they have all
moved before.

`pf_enabled` and `esi_enabled` both default **false**. A company that has not
configured statutory deductions must not have them silently start appearing on
payslips the month after this migration runs.

`employee_profiles.pf_applicable` / `esi_applicable` are **nullable booleans**,
and the null is load-bearing: it means "follow the company default", which is the
answer for almost everybody. A non-null boolean would have had to pick a side for
the entire existing workforce.

`payslips.employer_contributions` records what the company paid on top — PF, EPS,
ESI and LWF employer shares. Stored rather than derived because it is the missing
half of CTC, which checkpoint 1 deliberately declined to invent.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'f9b4d7e68a25'
down_revision: Union[str, None] = 'e8a3c6d57f14'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'statutory_configs',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('org_id', sa.Uuid(), nullable=False),

        # Off by default: deductions must not begin appearing unasked.
        sa.Column('pf_enabled', sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column('pf_employee_rate_bps', sa.Integer(), nullable=False,
                  server_default='1200'),
        sa.Column('pf_employer_rate_bps', sa.Integer(), nullable=False,
                  server_default='1200'),
        sa.Column('pf_pension_rate_bps', sa.Integer(), nullable=False,
                  server_default='833'),
        sa.Column('pf_wage_ceiling', sa.Integer(), nullable=False,
                  server_default='1500000'),
        sa.Column('pf_cap_at_ceiling', sa.Boolean(), nullable=False,
                  server_default=sa.true()),
        sa.Column('pf_pension_cap_at_ceiling', sa.Boolean(), nullable=False,
                  server_default=sa.true()),

        sa.Column('esi_enabled', sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column('esi_employee_rate_bps', sa.Integer(), nullable=False,
                  server_default='75'),
        sa.Column('esi_employer_rate_bps', sa.Integer(), nullable=False,
                  server_default='325'),
        sa.Column('esi_wage_threshold', sa.Integer(), nullable=False,
                  server_default='2100000'),

        sa.Column('pt_enabled', sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column('pt_state', sa.String(length=80), nullable=True),

        sa.Column('lwf_enabled', sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column('lwf_employee_amount', sa.Integer(), nullable=False,
                  server_default='0'),
        sa.Column('lwf_employer_amount', sa.Integer(), nullable=False,
                  server_default='0'),
        sa.Column('lwf_month', sa.Integer(), nullable=True),

        sa.Column('created_at', sa.DateTime(timezone=True),
                  server_default=sa.text('CURRENT_TIMESTAMP'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True),
                  server_default=sa.text('CURRENT_TIMESTAMP'), nullable=False),
        sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.CheckConstraint(
            'pf_employee_rate_bps BETWEEN 0 AND 10000 '
            'AND pf_employer_rate_bps BETWEEN 0 AND 10000 '
            'AND pf_pension_rate_bps BETWEEN 0 AND 10000',
            name='ck_statutory_pf_rates',
        ),
        sa.CheckConstraint(
            'esi_employee_rate_bps BETWEEN 0 AND 10000 '
            'AND esi_employer_rate_bps BETWEEN 0 AND 10000',
            name='ck_statutory_esi_rates',
        ),
    )
    op.create_index('ix_statutory_configs_org', 'statutory_configs', ['org_id'],
                    unique=True)

    op.create_table(
        'professional_tax_slabs',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('org_id', sa.Uuid(), nullable=False),
        sa.Column('min_gross', sa.Integer(), nullable=False),
        # NULL = the top slab, no upper bound.
        sa.Column('max_gross', sa.Integer(), nullable=True),
        sa.Column('amount', sa.Integer(), nullable=False),
        # NULL = every month. Several states charge differently in one month.
        sa.Column('applies_in_month', sa.Integer(), nullable=True),
        sa.Column('label', sa.String(length=120), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True),
                  server_default=sa.text('CURRENT_TIMESTAMP'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True),
                  server_default=sa.text('CURRENT_TIMESTAMP'), nullable=False),
        sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.CheckConstraint('min_gross >= 0 AND amount >= 0',
                           name='ck_pt_slabs_amounts'),
        sa.CheckConstraint('max_gross IS NULL OR max_gross >= min_gross',
                           name='ck_pt_slabs_range'),
    )
    op.create_index('ix_professional_tax_slabs_org_id', 'professional_tax_slabs',
                    ['org_id'])
    op.create_index('ix_pt_slabs_org', 'professional_tax_slabs',
                    ['org_id', 'min_gross'])

    with op.batch_alter_table('employee_profiles', schema=None) as batch_op:
        # Nullable, and the null means "follow the company".
        batch_op.add_column(sa.Column('pf_applicable', sa.Boolean(), nullable=True))
        batch_op.add_column(sa.Column('esi_applicable', sa.Boolean(), nullable=True))

    with op.batch_alter_table('payslips', schema=None) as batch_op:
        batch_op.add_column(
            sa.Column('employer_contributions', sa.Integer(), nullable=False,
                      server_default='0')
        )


def downgrade() -> None:
    with op.batch_alter_table('payslips', schema=None) as batch_op:
        batch_op.drop_column('employer_contributions')

    with op.batch_alter_table('employee_profiles', schema=None) as batch_op:
        batch_op.drop_column('esi_applicable')
        batch_op.drop_column('pf_applicable')

    op.drop_index('ix_pt_slabs_org', table_name='professional_tax_slabs')
    op.drop_index('ix_professional_tax_slabs_org_id',
                  table_name='professional_tax_slabs')
    op.drop_table('professional_tax_slabs')

    op.drop_index('ix_statutory_configs_org', table_name='statutory_configs')
    op.drop_table('statutory_configs')
