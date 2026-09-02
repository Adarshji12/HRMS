"""work mode on punch, per-mode geofence policy, per-employee geofence exemption

Revision ID: c4e18a72d9f3
Revises: a7c2e5f93b18
Create Date: 2026-08-27 14:10:00.000000

Entirely additive, and deliberately so: every column here is nullable or carries
a server default that reproduces today's behaviour exactly.

* ``attendance_records.work_mode`` is NULL for every row written before this
  migration, and stays NULL for every punch the desktop agent fills in — the
  agent observes a session starting, it does not know whether the desk is at
  home or in the office.
* The three ``attendance_settings.geofence_*`` overrides are NULL, meaning
  "follow ``geofence_enforcement``". A tenant that never opens the new screen
  keeps precisely the policy it has today.
* ``users.can_punch_anywhere`` defaults to **False**, unlike most permission
  flags on that table, because it removes a control rather than granting a
  capability. An org with geofencing on expects it to apply to everybody until
  somebody is deliberately excused.

The server default on the boolean is stated so the ALTER can run against a
non-empty table on Postgres without a rewrite step; SQLAlchemy's model-side
default handles new rows thereafter.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'c4e18a72d9f3'
down_revision: Union[str, None] = 'a7c2e5f93b18'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'attendance_records',
        sa.Column('work_mode', sa.String(length=20), nullable=True),
    )
    op.add_column(
        'attendance_settings',
        sa.Column('geofence_office', sa.String(length=16), nullable=True),
    )
    op.add_column(
        'attendance_settings',
        sa.Column('geofence_work_from_home', sa.String(length=16), nullable=True),
    )
    op.add_column(
        'attendance_settings',
        sa.Column('geofence_on_duty', sa.String(length=16), nullable=True),
    )
    op.add_column(
        'users',
        sa.Column(
            'can_punch_anywhere',
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )


def downgrade() -> None:
    op.drop_column('users', 'can_punch_anywhere')
    op.drop_column('attendance_settings', 'geofence_on_duty')
    op.drop_column('attendance_settings', 'geofence_work_from_home')
    op.drop_column('attendance_settings', 'geofence_office')
    op.drop_column('attendance_records', 'work_mode')
