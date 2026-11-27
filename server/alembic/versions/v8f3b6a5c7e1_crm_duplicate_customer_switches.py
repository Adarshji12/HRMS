"""CRM: switches for whether two customers may share a name, company or mobile number

Revision ID: v8f3b6a5c7e1
Revises: u7e2a5f4b6d0
"""

import sqlalchemy as sa
from alembic import op

revision = "v8f3b6a5c7e1"
down_revision = "u7e2a5f4b6d0"
branch_labels = None
depends_on = None

COLUMNS = ("allow_duplicate_customer_name", "allow_duplicate_customer_company", "allow_duplicate_customer_mobile")


def upgrade() -> None:
    with op.batch_alter_table("crm_settings") as batch:
        for name in COLUMNS:
            batch.add_column(sa.Column(name, sa.Boolean(), nullable=False, server_default=sa.true()))


def downgrade() -> None:
    with op.batch_alter_table("crm_settings") as batch:
        for name in COLUMNS:
            batch.drop_column(name)
