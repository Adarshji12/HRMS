"""plan catalogue

The plan table. Rows are seeded from app.core.plans at startup rather than in
this migration, so the built-in catalogue has exactly one definition and a
later price change ships as a code edit rather than a second migration that
disagrees with the first.

Revision ID: a3f1c72b9d04
Revises: fab25be2393b
Create Date: 2026-08-21 00:00:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'a3f1c72b9d04'
down_revision: Union[str, None] = 'fab25be2393b'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'plans',
        sa.Column('id', sa.String(length=32), nullable=False),
        sa.Column('name', sa.String(length=80), nullable=False),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('base_price_annual', sa.Integer(), nullable=False),
        sa.Column('per_employee_month', sa.Integer(), nullable=False),
        sa.Column('min_employees', sa.Integer(), nullable=False),
        sa.Column('max_employees', sa.Integer(), nullable=False),
        sa.Column('max_screenshot_retention_days', sa.Integer(), nullable=False),
        sa.Column('max_activity_retention_days', sa.Integer(), nullable=False),
        sa.Column('min_screenshot_interval_s', sa.Integer(), nullable=False),
        sa.Column('storage_gb', sa.Integer(), nullable=False),
        sa.Column('features', sa.JSON(), nullable=False),
        sa.Column('is_active', sa.Boolean(), nullable=False),
        sa.Column('is_public', sa.Boolean(), nullable=False),
        sa.Column('is_builtin', sa.Boolean(), nullable=False),
        sa.Column('sort_order', sa.Integer(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_plans')),
    )


def downgrade() -> None:
    op.drop_table('plans')
