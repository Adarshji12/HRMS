"""CRM: switch for refusing a second lead on the same mobile number

Revision ID: u7e2a5f4b6d0
Revises: t6d1f4e3a5c9
"""

import sqlalchemy as sa
from alembic import op

revision = "u7e2a5f4b6d0"
down_revision = "t6d1f4e3a5c9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("crm_settings") as batch:
        batch.add_column(sa.Column("block_duplicate_leads", sa.Boolean(), nullable=False, server_default=sa.true()))


def downgrade() -> None:
    with op.batch_alter_table("crm_settings") as batch:
        batch.drop_column("block_duplicate_leads")
