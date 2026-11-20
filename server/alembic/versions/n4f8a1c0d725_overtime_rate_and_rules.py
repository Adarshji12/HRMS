"""Overtime: the rate, multipliers, rounding, cap and the approval and payroll switches

Revision ID: n4f8a1c0d725
Revises: m3e7f0b9c614

Defaults keep today's behaviour: salary-derived rate, 1x on a working day and 2x on a day off
(day-off work already counted whole), no rounding, no cap, manager approval on, and nothing
paid through payroll.
"""

import sqlalchemy as sa
from alembic import op

revision = "n4f8a1c0d725"
down_revision = "m3e7f0b9c614"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("attendance_settings") as batch:
        batch.add_column(sa.Column("overtime_rate_mode", sa.String(length=8), nullable=False, server_default="salary"))
        batch.add_column(sa.Column("overtime_derived_from", sa.String(length=8), nullable=False, server_default="basic"))
        batch.add_column(sa.Column("overtime_flat_rate_paise", sa.Integer(), nullable=False, server_default="0"))
        batch.add_column(sa.Column("overtime_mult_working_x100", sa.Integer(), nullable=False, server_default="100"))
        batch.add_column(sa.Column("overtime_mult_off_x100", sa.Integer(), nullable=False, server_default="200"))
        batch.add_column(sa.Column("overtime_mult_holiday_x100", sa.Integer(), nullable=False, server_default="200"))
        batch.add_column(sa.Column("overtime_round_minutes", sa.Integer(), nullable=False, server_default="0"))
        batch.add_column(sa.Column("overtime_max_hours_month", sa.Integer(), nullable=False, server_default="0"))
        batch.add_column(sa.Column("overtime_requires_approval", sa.Boolean(), nullable=False, server_default=sa.true()))
        batch.add_column(sa.Column("overtime_pay_through_payroll", sa.Boolean(), nullable=False, server_default=sa.false()))


def downgrade() -> None:
    with op.batch_alter_table("attendance_settings") as batch:
        for column in ("overtime_pay_through_payroll", "overtime_requires_approval", "overtime_max_hours_month",
                       "overtime_round_minutes", "overtime_mult_holiday_x100", "overtime_mult_off_x100",
                       "overtime_mult_working_x100", "overtime_flat_rate_paise", "overtime_derived_from",
                       "overtime_rate_mode"):
            batch.drop_column(column)
