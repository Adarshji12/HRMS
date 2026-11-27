"""CRM: switch for whether two leads may share a name

Revision ID: w9a4c7b6d8f2
Revises: v8f3b6a5c7e1
"""

import sqlalchemy as sa
from alembic import op

revision = "w9a4c7b6d8f2"
down_revision = "v8f3b6a5c7e1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("crm_settings") as batch:
        batch.add_column(sa.Column("allow_duplicate_lead_name", sa.Boolean(), nullable=False, server_default=sa.false()))


def downgrade() -> None:
    with op.batch_alter_table("crm_settings") as batch:
        batch.drop_column("allow_duplicate_lead_name")
