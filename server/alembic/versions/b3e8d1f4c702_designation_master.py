"""designation master

Revision ID: b3e8d1f4c702
Revises: a91c3e5d7f20
Create Date: 2026-10-21 12:00:00.000000

Two changes for the Designation Master screen.

A designation can belong to one department; null keeps the old meaning, a
title used anywhere.

Seniority flips to a ladder: level 1 is the most senior, where before a larger
number was. Existing titles are renumbered per organisation by dense rank of
the old value, so their order is kept exactly and two titles that shared a
level still share one.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'b3e8d1f4c702'
down_revision: Union[str, None] = 'a91c3e5d7f20'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('designations', schema=None) as batch_op:
        batch_op.add_column(sa.Column('department_id', sa.Uuid(), nullable=True))
        batch_op.create_foreign_key(
            batch_op.f('fk_designations_department_id_departments'),
            'departments', ['department_id'], ['id'], ondelete='SET NULL',
        )

    bind = op.get_bind()
    rows = bind.execute(sa.text('SELECT id, org_id, level FROM designations')).fetchall()
    by_org: dict = {}
    for row in rows:
        by_org.setdefault(row.org_id, []).append(row)
    for titles in by_org.values():
        old_levels = sorted({t.level for t in titles}, reverse=True)
        rank = {old: index + 1 for index, old in enumerate(old_levels)}
        for t in titles:
            bind.execute(
                sa.text('UPDATE designations SET level = :level WHERE id = :id'),
                {'level': rank[t.level], 'id': t.id},
            )


def downgrade() -> None:
    # Back to "larger is more senior". The original spacing is not recoverable,
    # only the order, which is all anything read it for.
    op.execute('UPDATE designations SET level = 101 - level')
    with op.batch_alter_table('designations', schema=None) as batch_op:
        batch_op.drop_constraint(
            batch_op.f('fk_designations_department_id_departments'), type_='foreignkey'
        )
        batch_op.drop_column('department_id')
