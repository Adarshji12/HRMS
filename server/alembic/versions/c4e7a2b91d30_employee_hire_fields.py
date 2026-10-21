"""employee hire fields

Revision ID: c4e7a2b91d30
Revises: 50be0635be86
Create Date: 2026-10-20 15:10:00.000000

Three columns the new Add Employee form collects at hire: the parent's or
spouse's name statutory forms ask for, how the person's attendance is expected
to be captured, and their pay grade. All nullable — existing records simply
have not been told yet.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'c4e7a2b91d30'
down_revision: Union[str, None] = '50be0635be86'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('employee_profiles') as batch:
        batch.add_column(sa.Column('father_name', sa.String(length=160), nullable=True))
        batch.add_column(sa.Column('attendance_type', sa.String(length=20), nullable=True))
        batch.add_column(sa.Column('grade', sa.String(length=40), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('employee_profiles') as batch:
        batch.drop_column('grade')
        batch.drop_column('attendance_type')
        batch.drop_column('father_name')
