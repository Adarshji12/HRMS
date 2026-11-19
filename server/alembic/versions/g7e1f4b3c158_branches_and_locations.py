"""Branches, and richer locations

Revision ID: g7e1f4b3c158
Revises: f6d9e3a2b047

A branch is a company site with an address and contacts. A location is the existing
geofenced office: it now says which branch it belongs to and where it is, and its
coordinates become optional so a site can be listed before it is mapped. A location
with no coordinates is simply never used for the punch check.
"""

import sqlalchemy as sa
from alembic import op

revision = "g7e1f4b3c158"
down_revision = "f6d9e3a2b047"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "branches",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("org_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("code", sa.String(length=12), nullable=True),
        sa.Column("address", sa.String(length=500), nullable=True),
        sa.Column("country", sa.String(length=80), nullable=True),
        sa.Column("state", sa.String(length=120), nullable=True),
        sa.Column("district", sa.String(length=120), nullable=True),
        sa.Column("city", sa.String(length=120), nullable=True),
        sa.Column("pincode", sa.String(length=12), nullable=True),
        sa.Column("phone", sa.String(length=32), nullable=True),
        sa.Column("email", sa.String(length=254), nullable=True),
        sa.Column("is_head_office", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["org_id"], ["organizations.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("org_id", "name", name="uq_branches_org_name"),
    )
    op.create_index("ix_branches_org_id", "branches", ["org_id"])

    with op.batch_alter_table("office_locations") as batch:
        batch.add_column(sa.Column("branch_id", sa.Uuid(), nullable=True))
        batch.add_column(sa.Column("state", sa.String(length=120), nullable=True))
        batch.add_column(sa.Column("district", sa.String(length=120), nullable=True))
        batch.add_column(sa.Column("city", sa.String(length=120), nullable=True))
        batch.alter_column("lat", existing_type=sa.Float(), nullable=True)
        batch.alter_column("lng", existing_type=sa.Float(), nullable=True)
        batch.create_foreign_key("fk_office_locations_branch", "branches", ["branch_id"], ["id"], ondelete="SET NULL")


def downgrade() -> None:
    with op.batch_alter_table("office_locations") as batch:
        batch.drop_constraint("fk_office_locations_branch", type_="foreignkey")
        batch.drop_column("city")
        batch.drop_column("district")
        batch.drop_column("state")
        batch.drop_column("branch_id")
    op.drop_index("ix_branches_org_id", table_name="branches")
    op.drop_table("branches")
