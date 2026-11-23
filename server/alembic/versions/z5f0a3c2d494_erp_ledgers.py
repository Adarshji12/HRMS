"""ERP ledgers

Revision ID: z5f0a3c2d494
Revises: y4e9f2b1c383
"""

import sqlalchemy as sa
from alembic import op

revision = "z5f0a3c2d494"
down_revision = "y4e9f2b1c383"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "erp_ledgers",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("org_id", sa.Uuid(), nullable=False),
        sa.Column("code", sa.String(length=24), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("account_group", sa.String(length=80), nullable=False),
        sa.Column("station", sa.String(length=120), nullable=True),
        sa.Column("mail_to", sa.String(length=200), nullable=True),
        sa.Column("address1", sa.String(length=200), nullable=True),
        sa.Column("address2", sa.String(length=200), nullable=True),
        sa.Column("address3", sa.String(length=200), nullable=True),
        sa.Column("country", sa.String(length=80), nullable=True),
        sa.Column("state", sa.String(length=120), nullable=True),
        sa.Column("city", sa.String(length=120), nullable=True),
        sa.Column("pincode", sa.String(length=12), nullable=True),
        sa.Column("category", sa.String(length=80), nullable=True),
        sa.Column("balancing_method", sa.String(length=16), nullable=False, server_default="bill_by_bill"),
        sa.Column("opening_balance", sa.Numeric(14, 2), nullable=False, server_default="0"),
        sa.Column("opening_type", sa.String(length=2), nullable=False, server_default="dr"),
        sa.Column("credit_days", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("credit_limit", sa.Numeric(14, 2), nullable=True),
        sa.Column("mobile", sa.String(length=24), nullable=True),
        sa.Column("whatsapp", sa.String(length=24), nullable=True),
        sa.Column("mobile1", sa.String(length=24), nullable=True),
        sa.Column("ledger_type", sa.String(length=20), nullable=False, server_default="unregistered"),
        sa.Column("gstin", sa.String(length=20), nullable=True),
        sa.Column("pan", sa.String(length=12), nullable=True),
        sa.Column("contact_person", sa.String(length=120), nullable=True),
        sa.Column("designation", sa.String(length=80), nullable=True),
        sa.Column("email", sa.String(length=255), nullable=True),
        sa.Column("dob", sa.Date(), nullable=True),
        sa.Column("anniversary", sa.Date(), nullable=True),
        sa.Column("website", sa.String(length=200), nullable=True),
        sa.Column("bank_holder", sa.String(length=160), nullable=True),
        sa.Column("bank_name", sa.String(length=160), nullable=True),
        sa.Column("bank_account", sa.String(length=40), nullable=True),
        sa.Column("ifsc", sa.String(length=16), nullable=True),
        sa.Column("bank_branch", sa.String(length=160), nullable=True),
        sa.Column("bill_at", sa.String(length=24), nullable=False, server_default="sale_bill_setting"),
        sa.Column("salesman", sa.String(length=120), nullable=True),
        sa.Column("area_route", sa.String(length=120), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_by", sa.Uuid(), nullable=True),
        sa.ForeignKeyConstraint(["org_id"], ["organizations.id"], name=op.f("fk_erp_ledgers_org_id_organizations"), ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"], name=op.f("fk_erp_ledgers_created_by_users"), ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_erp_ledgers")),
        sa.UniqueConstraint("org_id", "code", name="uq_erp_ledgers_org_code"),
    )
    op.create_index(op.f("ix_erp_ledgers_org_id"), "erp_ledgers", ["org_id"])
    op.create_index(op.f("ix_erp_ledgers_name"), "erp_ledgers", ["name"])


def downgrade() -> None:
    op.drop_index(op.f("ix_erp_ledgers_name"), table_name="erp_ledgers")
    op.drop_index(op.f("ix_erp_ledgers_org_id"), table_name="erp_ledgers")
    op.drop_table("erp_ledgers")
