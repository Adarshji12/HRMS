"""hr settings

Revision ID: a91c3e5d7f20
Revises: 7d2f9c4a1e60
Create Date: 2026-10-20 18:00:00.000000

One row per organisation of HR-wide defaults: the employee ID format and its
counter, default probation and notice, and how far ahead the HR dashboard
warns about probations ending and documents expiring. Created on first read,
so existing companies need no data step.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'a91c3e5d7f20'
down_revision: Union[str, None] = '7d2f9c4a1e60'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'hr_settings',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('org_id', sa.Uuid(), nullable=False),
        sa.Column('emp_code_prefix', sa.String(length=12), nullable=False, server_default='EMP'),
        sa.Column('emp_code_separator', sa.String(length=3), nullable=False, server_default='-'),
        sa.Column('emp_code_digits', sa.Integer(), nullable=False, server_default='4'),
        sa.Column('emp_code_next', sa.Integer(), nullable=False, server_default='1'),
        sa.Column('default_probation_months', sa.Integer(), nullable=False, server_default='6'),
        sa.Column('default_notice_days', sa.Integer(), nullable=False, server_default='30'),
        sa.Column('probation_warn_days', sa.Integer(), nullable=False, server_default='30'),
        sa.Column('document_warn_days', sa.Integer(), nullable=False, server_default='60'),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('org_id', name='uq_hr_settings_org'),
    )
    op.create_index('ix_hr_settings_org_id', 'hr_settings', ['org_id'])


def downgrade() -> None:
    op.drop_index('ix_hr_settings_org_id', table_name='hr_settings')
    op.drop_table('hr_settings')
