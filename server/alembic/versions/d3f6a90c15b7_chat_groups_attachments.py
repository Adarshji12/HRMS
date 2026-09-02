"""chat: group channels and one attachment per message

Revision ID: d3f6a90c15b7
Revises: c4a91b7e5d02
Create Date: 2026-09-01 14:20:00.000000

Five nullable columns on two existing tables. Nothing is backfilled, no table is
created, and every existing row stays valid — a message with no attachment has
four NULLs, which is what every message written before today is.

``chat_channels.created_by`` is NULL on every derived channel, and that is not
a "not set yet": nobody created a team or department channel, the org chart did.
It is only filled for the new ``group`` kind.

The ``kind`` column already holds a free string, so the fourth channel kind
needs no schema change at all — ``ChannelKind`` gained ``GROUP`` and the column
accepts it. That is the reason this migration is as small as it is.

Downgrade drops the columns, which loses the record of which files were sent
and orphans their objects in storage. The objects themselves are left alone
deliberately: a migration that deletes a company's uploaded files as a side
effect of a rollback is a migration nobody can safely run.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'd3f6a90c15b7'
down_revision: Union[str, None] = 'c4a91b7e5d02'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('chat_channels') as batch:
        batch.add_column(sa.Column('created_by', sa.Uuid(), nullable=True))
        # SET NULL: the person who started a project channel leaving the company
        # must not delete the conversation underneath everyone still in it.
        batch.create_foreign_key(
            batch.f('fk_chat_channels_created_by_users'),
            'users', ['created_by'], ['id'], ondelete='SET NULL',
        )

    with op.batch_alter_table('chat_messages') as batch:
        batch.add_column(sa.Column('attachment_key', sa.String(length=512), nullable=True))
        batch.add_column(sa.Column('attachment_name', sa.String(length=255), nullable=True))
        batch.add_column(sa.Column('attachment_type', sa.String(length=120), nullable=True))
        batch.add_column(sa.Column('attachment_size', sa.Integer(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('chat_messages') as batch:
        batch.drop_column('attachment_size')
        batch.drop_column('attachment_type')
        batch.drop_column('attachment_name')
        batch.drop_column('attachment_key')

    with op.batch_alter_table('chat_channels') as batch:
        batch.drop_constraint(batch.f('fk_chat_channels_created_by_users'), type_='foreignkey')
        batch.drop_column('created_by')
