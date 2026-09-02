"""team chat: channels, messages and read state

Revision ID: f1c94ab27d63
Revises: e7a3c81b45d2
Create Date: 2026-08-31 18:05:00.000000

Four new tables and nothing touched. No existing row changes, no backfill, and
no channel is created here.

**Channels are provisioned lazily, not seeded.** A migration that created one
channel per existing team would be a guess about which teams want a channel and
would leave every team created *after* this deploy without one — so the same
lazy path would have to exist anyway, and there would then be two ways a channel
comes into being. ``services.chat.ensure_channels`` is the only one.

The two unique constraints on ``(org_id, team_id)`` and ``(org_id,
department_id)`` are what make that lazy path safe: two requests racing to
provision the same team's channel on a Monday morning is the ordinary case, and
the loser must fail on a constraint and re-read rather than create a duplicate.
They are nullable columns, and SQL permits NULLs to repeat under a unique index,
so a direct channel leaving both NULL costs nothing.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'f1c94ab27d63'
down_revision: Union[str, None] = 'e7a3c81b45d2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'chat_channels',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('org_id', sa.Uuid(), nullable=False),
        sa.Column('kind', sa.String(length=16), nullable=False),
        sa.Column('team_id', sa.Uuid(), nullable=True),
        sa.Column('department_id', sa.Uuid(), nullable=True),
        sa.Column('pair_key', sa.String(length=80), nullable=True),
        sa.Column('name', sa.String(length=120), nullable=True),
        sa.Column('last_message_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('is_archived', sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], ondelete='CASCADE',
                                name=op.f('fk_chat_channels_org_id_organizations')),
        # CASCADE: a channel whose membership rule points at a deleted team has
        # no readers and no way to gain any.
        sa.ForeignKeyConstraint(['team_id'], ['teams.id'], ondelete='CASCADE',
                                name=op.f('fk_chat_channels_team_id_teams')),
        sa.ForeignKeyConstraint(['department_id'], ['departments.id'], ondelete='CASCADE',
                                name=op.f('fk_chat_channels_department_id_departments')),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_chat_channels')),
        sa.UniqueConstraint('org_id', 'team_id', name='uq_chat_channels_org_team'),
        sa.UniqueConstraint('org_id', 'department_id', name='uq_chat_channels_org_department'),
        sa.UniqueConstraint('org_id', 'pair_key', name='uq_chat_channels_org_pair'),
    )
    op.create_index('ix_chat_channels_org_id', 'chat_channels', ['org_id'])
    op.create_index('ix_chat_channels_team_id', 'chat_channels', ['team_id'])
    op.create_index('ix_chat_channels_department_id', 'chat_channels', ['department_id'])
    op.create_index('ix_chat_channels_org_kind', 'chat_channels', ['org_id', 'kind'])

    op.create_table(
        'chat_channel_members',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('org_id', sa.Uuid(), nullable=False),
        sa.Column('channel_id', sa.Uuid(), nullable=False),
        sa.Column('user_id', sa.Uuid(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], ondelete='CASCADE',
                                name=op.f('fk_chat_channel_members_org_id_organizations')),
        sa.ForeignKeyConstraint(['channel_id'], ['chat_channels.id'], ondelete='CASCADE',
                                name=op.f('fk_chat_channel_members_channel_id_chat_channels')),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE',
                                name=op.f('fk_chat_channel_members_user_id_users')),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_chat_channel_members')),
        sa.UniqueConstraint('channel_id', 'user_id', name='uq_chat_members_channel_user'),
    )
    op.create_index('ix_chat_channel_members_org_id', 'chat_channel_members', ['org_id'])
    op.create_index('ix_chat_channel_members_channel_id', 'chat_channel_members', ['channel_id'])
    op.create_index('ix_chat_members_user', 'chat_channel_members', ['user_id'])

    op.create_table(
        'chat_messages',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('org_id', sa.Uuid(), nullable=False),
        sa.Column('channel_id', sa.Uuid(), nullable=False),
        sa.Column('user_id', sa.Uuid(), nullable=True),
        sa.Column('body', sa.Text(), nullable=False),
        sa.Column('edited_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], ondelete='CASCADE',
                                name=op.f('fk_chat_messages_org_id_organizations')),
        sa.ForeignKeyConstraint(['channel_id'], ['chat_channels.id'], ondelete='CASCADE',
                                name=op.f('fk_chat_messages_channel_id_chat_channels')),
        # SET NULL: deleting an employee must not close the thread up around
        # their side of every conversation they were part of.
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='SET NULL',
                                name=op.f('fk_chat_messages_user_id_users')),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_chat_messages')),
    )
    op.create_index('ix_chat_messages_org_id', 'chat_messages', ['org_id'])
    op.create_index('ix_chat_messages_user_id', 'chat_messages', ['user_id'])
    op.create_index('ix_chat_messages_channel_created', 'chat_messages',
                    ['channel_id', 'created_at'])

    op.create_table(
        'chat_reads',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('org_id', sa.Uuid(), nullable=False),
        sa.Column('channel_id', sa.Uuid(), nullable=False),
        sa.Column('user_id', sa.Uuid(), nullable=False),
        sa.Column('last_read_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], ondelete='CASCADE',
                                name=op.f('fk_chat_reads_org_id_organizations')),
        sa.ForeignKeyConstraint(['channel_id'], ['chat_channels.id'], ondelete='CASCADE',
                                name=op.f('fk_chat_reads_channel_id_chat_channels')),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE',
                                name=op.f('fk_chat_reads_user_id_users')),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_chat_reads')),
        sa.UniqueConstraint('channel_id', 'user_id', name='uq_chat_reads_channel_user'),
    )
    op.create_index('ix_chat_reads_org_id', 'chat_reads', ['org_id'])
    op.create_index('ix_chat_reads_user', 'chat_reads', ['user_id'])


def downgrade() -> None:
    op.drop_table('chat_reads')
    op.drop_table('chat_messages')
    op.drop_table('chat_channel_members')
    op.drop_table('chat_channels')
