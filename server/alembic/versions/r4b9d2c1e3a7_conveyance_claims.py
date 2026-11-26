"""Local conveyance claims

Revision ID: r4b9d2c1e3a7
Revises: q3a8c1b0d2f6
"""

import sqlalchemy as sa
from alembic import op

revision = "r4b9d2c1e3a7"
down_revision = "q3a8c1b0d2f6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("expense_claims") as batch:
        batch.add_column(sa.Column("claim_type", sa.String(length=20), nullable=False, server_default="general"))
        batch.add_column(sa.Column("employee_grade", sa.String(length=60), nullable=True))
        batch.add_column(sa.Column("work_location", sa.String(length=120), nullable=True))
        batch.add_column(sa.Column("project_label", sa.String(length=160), nullable=True))
    with op.batch_alter_table("expense_lines") as batch:
        batch.add_column(sa.Column("start_time", sa.String(length=5), nullable=True))
        batch.add_column(sa.Column("end_time", sa.String(length=5), nullable=True))
        batch.add_column(sa.Column("from_location", sa.String(length=160), nullable=True))
        batch.add_column(sa.Column("to_location", sa.String(length=160), nullable=True))
        batch.add_column(sa.Column("customer_name", sa.String(length=160), nullable=True))
        batch.add_column(sa.Column("so_number", sa.String(length=60), nullable=True))
        batch.add_column(sa.Column("conveyance_mode", sa.String(length=60), nullable=True))
        batch.add_column(sa.Column("distance_km", sa.Float(), nullable=True))
        batch.add_column(sa.Column("rate_per_km", sa.Integer(), nullable=True))
        batch.add_column(sa.Column("conveyance_amount", sa.Integer(), nullable=True))
        batch.add_column(sa.Column("food_amount", sa.Integer(), nullable=False, server_default="0"))
        batch.add_column(sa.Column("parking_amount", sa.Integer(), nullable=False, server_default="0"))
        batch.add_column(sa.Column("remarks", sa.String(length=300), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("expense_lines") as batch:
        for name in ("remarks", "parking_amount", "food_amount", "conveyance_amount", "rate_per_km", "distance_km",
                     "conveyance_mode", "so_number", "customer_name", "to_location", "from_location", "end_time", "start_time"):
            batch.drop_column(name)
    with op.batch_alter_table("expense_claims") as batch:
        for name in ("project_label", "work_location", "employee_grade", "claim_type"):
            batch.drop_column(name)
