"""meetings: scheduled calls, their invitee list, and who turned up

Revision ID: a2d67f04b9e1
Revises: f1c94ab27d63
Create Date: 2026-08-31 20:10:00.000000

Two tables and one nullable column on ``organizations``. Nothing existing is
touched and nothing is backfilled.

``meetings.room`` is unique per company and carries a random token, never
anything derived from the title — on a public Jitsi deployment the room name is
the only thing standing between a meeting and a stranger, so it must not be
guessable from information the stranger already has. The unique constraint is
there to make a collision an error rather than two companies silently sharing a
call.

``organizations.meeting_domain`` is nullable and means "use the server default".
Filling it in per tenant is how a customer who cannot send staff video through
somebody else's servers points at their own Jitsi.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'a2d67f04b9e1'
down_revision: Union[str, None] = 'f1c94ab27d63'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('organizations') as batch:
        batch.add_column(sa.Column('meeting_domain', sa.String(length=200), nullable=True))

    op.create_table(
        'meetings',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('org_id', sa.Uuid(), nullable=False),
        sa.Column('title', sa.String(length=200), nullable=False),
        sa.Column('agenda', sa.Text(), nullable=True),
        sa.Column('starts_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('duration_minutes', sa.Integer(), nullable=False, server_default='30'),
        sa.Column('host_user_id', sa.Uuid(), nullable=True),
        sa.Column('room', sa.String(length=64), nullable=False),
        sa.Column('status', sa.String(length=16), nullable=False, server_default='scheduled'),
        sa.Column('seeded_from', sa.String(length=120), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], ondelete='CASCADE',
                                name=op.f('fk_meetings_org_id_organizations')),
        # SET NULL: deleting an employee must not delete the meetings they
        # organised out of everybody else's calendar.
        sa.ForeignKeyConstraint(['host_user_id'], ['users.id'], ondelete='SET NULL',
                                name=op.f('fk_meetings_host_user_id_users')),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_meetings')),
        sa.UniqueConstraint('org_id', 'room', name='uq_meetings_org_room'),
    )
    op.create_index('ix_meetings_org_id', 'meetings', ['org_id'])
    op.create_index('ix_meetings_host_user_id', 'meetings', ['host_user_id'])
    op.create_index('ix_meetings_org_start', 'meetings', ['org_id', 'starts_at'])

    op.create_table(
        'meeting_invitees',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('org_id', sa.Uuid(), nullable=False),
        sa.Column('meeting_id', sa.Uuid(), nullable=False),
        sa.Column('user_id', sa.Uuid(), nullable=False),
        sa.Column('joined_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], ondelete='CASCADE',
                                name=op.f('fk_meeting_invitees_org_id_organizations')),
        sa.ForeignKeyConstraint(['meeting_id'], ['meetings.id'], ondelete='CASCADE',
                                name=op.f('fk_meeting_invitees_meeting_id_meetings')),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE',
                                name=op.f('fk_meeting_invitees_user_id_users')),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_meeting_invitees')),
        sa.UniqueConstraint('meeting_id', 'user_id', name='uq_meeting_invitees_meeting_user'),
    )
    op.create_index('ix_meeting_invitees_org_id', 'meeting_invitees', ['org_id'])
    op.create_index('ix_meeting_invitees_meeting_id', 'meeting_invitees', ['meeting_id'])
    op.create_index('ix_meeting_invitees_user', 'meeting_invitees', ['user_id'])


def downgrade() -> None:
    op.drop_table('meeting_invitees')
    op.drop_table('meetings')
    with op.batch_alter_table('organizations') as batch:
        batch.drop_column('meeting_domain')
