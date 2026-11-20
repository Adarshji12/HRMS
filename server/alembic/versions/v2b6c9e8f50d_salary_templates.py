"""Salary templates

Revision ID: v2b6c9e8f50d
Revises: u1a5b8d7e49c
"""

import sqlalchemy as sa
from alembic import op

revision = "v2b6c9e8f50d"
down_revision = "u1a5b8d7e49c"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "salary_templates",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("org_id", sa.Uuid(), sa.ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("component_ids", sa.JSON(), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("is_default", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.UniqueConstraint("org_id", "name", name="uq_salary_templates_name"),
    )
    op.create_index("ix_salary_templates_org_id", "salary_templates", ["org_id"])


def downgrade() -> None:
    op.drop_index("ix_salary_templates_org_id", table_name="salary_templates")
    op.drop_table("salary_templates")
