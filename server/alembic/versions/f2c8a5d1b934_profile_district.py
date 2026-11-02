"""profile district

Revision ID: f2c8a5d1b934
Revises: e3b9f6a1c527
Create Date: 2026-10-28 15:00:00.000000

A district for each of the two addresses on the employee record. The profile
form now picks country, state, district and city from the Geography master,
and the district sat between state and city with nowhere to be stored. Names,
not ids, like the city and state beside them: a master row renamed or retired
later must not change an address somebody already gave.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'f2c8a5d1b934'
down_revision: Union[str, None] = 'e3b9f6a1c527'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('employee_profiles') as batch:
        batch.add_column(sa.Column('current_district', sa.String(length=120), nullable=True))
        batch.add_column(sa.Column('permanent_district', sa.String(length=120), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('employee_profiles') as batch:
        batch.drop_column('permanent_district')
        batch.drop_column('current_district')
