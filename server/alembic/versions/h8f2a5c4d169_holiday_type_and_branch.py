"""Holidays: a type, and an optional branch

Revision ID: h8f2a5c4d169
Revises: g7e1f4b3c158

The holiday master adds a type (public, national, festival, optional, company) and
the branch a holiday applies to (none = every branch). Holidays already marked
optional become the Optional / Restricted type; the rest stay Public.
"""

import sqlalchemy as sa
from alembic import op

revision = "h8f2a5c4d169"
down_revision = "g7e1f4b3c158"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("holidays") as batch:
        batch.add_column(sa.Column("holiday_type", sa.String(length=16), nullable=False, server_default="public"))
        batch.add_column(sa.Column("branch_id", sa.Uuid(), nullable=True))
        batch.create_foreign_key("fk_holidays_branch", "branches", ["branch_id"], ["id"], ondelete="SET NULL")
    op.execute("UPDATE holidays SET holiday_type = 'optional' WHERE is_optional")


def downgrade() -> None:
    with op.batch_alter_table("holidays") as batch:
        batch.drop_constraint("fk_holidays_branch", type_="foreignkey")
        batch.drop_column("branch_id")
        batch.drop_column("holiday_type")
