"""Salary template rules: how each chosen component is worked out

Revision ID: w2c7d0f9a161
Revises: v2b6c9e8f50d
"""

import sqlalchemy as sa
from alembic import op

revision = "w2c7d0f9a161"
down_revision = "v2b6c9e8f50d"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("salary_templates") as batch:
        batch.add_column(sa.Column("rules", sa.JSON(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("salary_templates") as batch:
        batch.drop_column("rules")
