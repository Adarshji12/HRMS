"""CRM opportunities and the requirement-type master.

Revision ID: c9f4b6d28e51
Revises: b7d2f4a91c38
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "c9f4b6d28e51"
down_revision: Union[str, None] = "b7d2f4a91c38"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "crm_requirement_types",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("org_id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=80), nullable=False),
        sa.Column("sort_order", sa.Integer(), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["org_id"], ["organizations.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("org_id", "name", name="uq_crm_requirement_types_org_name"),
    )
    op.create_index("ix_crm_requirement_types_org_id", "crm_requirement_types", ["org_id"])

    op.create_table(
        "crm_opportunities",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("org_id", sa.Uuid(), nullable=False),
        sa.Column("lead_id", sa.Uuid(), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("expected_revenue", sa.Numeric(14, 2), nullable=False),
        sa.Column("probability", sa.Integer(), nullable=False),
        sa.Column("expected_closing", sa.Date(), nullable=True),
        sa.Column("priority", sa.Integer(), nullable=False),
        sa.Column("tags", sa.JSON(), nullable=False),
        sa.Column("requirement_type_id", sa.Uuid(), nullable=True),
        sa.Column("oem_id", sa.Uuid(), nullable=True),
        sa.Column("raw_cost", sa.Numeric(14, 2), nullable=True),
        sa.Column("team_id", sa.Uuid(), nullable=True),
        sa.Column("is_mail_send", sa.Boolean(), nullable=False),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("costsheet_key", sa.String(length=300), nullable=True),
        sa.Column("costsheet_name", sa.String(length=255), nullable=True),
        sa.Column("costsheet_type", sa.String(length=120), nullable=True),
        sa.Column("costsheet_size", sa.BigInteger(), nullable=True),
        sa.Column("quotation_key", sa.String(length=300), nullable=True),
        sa.Column("quotation_name", sa.String(length=255), nullable=True),
        sa.Column("quotation_type", sa.String(length=120), nullable=True),
        sa.Column("quotation_size", sa.BigInteger(), nullable=True),
        sa.Column("created_by", sa.Uuid(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["org_id"], ["organizations.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["lead_id"], ["crm_leads.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["requirement_type_id"], ["crm_requirement_types.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["oem_id"], ["crm_item_companies.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["team_id"], ["teams.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_crm_opportunities_org_id", "crm_opportunities", ["org_id"])
    op.create_index("ix_crm_opportunities_lead_id", "crm_opportunities", ["lead_id"])


def downgrade() -> None:
    op.drop_index("ix_crm_opportunities_lead_id", table_name="crm_opportunities")
    op.drop_index("ix_crm_opportunities_org_id", table_name="crm_opportunities")
    op.drop_table("crm_opportunities")
    op.drop_index("ix_crm_requirement_types_org_id", table_name="crm_requirement_types")
    op.drop_table("crm_requirement_types")
