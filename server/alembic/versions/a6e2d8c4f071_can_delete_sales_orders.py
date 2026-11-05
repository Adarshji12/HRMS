"""Permission to delete a sales order, apart from raising one.

Revision ID: a6e2d8c4f071
Revises: f4c9e7a2b315

The column follows its ERP siblings: true by default, and reaching nobody but
administrators, because ``services.erp.common.may`` turns away anybody with
neither a named role nor an administrator's rank. A named role answers from its
own permissions, so the two built-in roles that hold everything are granted it
here, and a company's custom roles stay without it until somebody ticks it.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "a6e2d8c4f071"
down_revision: Union[str, None] = "f4c9e7a2b315"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

KEY = "can_delete_sales_orders"


def upgrade() -> None:
    with op.batch_alter_table("users", schema=None) as batch_op:
        batch_op.add_column(sa.Column(KEY, sa.Boolean(), nullable=False, server_default=sa.true()))

    bind = op.get_bind()
    roles = sa.table(
        "org_roles", sa.column("id", sa.Uuid()), sa.column("name", sa.String()),
        sa.column("is_builtin", sa.Boolean()), sa.column("permissions", sa.JSON()),
    )
    rows = bind.execute(
        sa.select(roles.c.id, roles.c.permissions).where(
            roles.c.is_builtin.is_(True), roles.c.name.in_(["Owner", "Administrator"]))
    ).all()
    for role_id, permissions in rows:
        bind.execute(roles.update().where(roles.c.id == role_id).values(permissions={**(permissions or {}), KEY: True}))


def downgrade() -> None:
    bind = op.get_bind()
    roles = sa.table("org_roles", sa.column("id", sa.Uuid()), sa.column("permissions", sa.JSON()))
    for role_id, permissions in bind.execute(sa.select(roles.c.id, roles.c.permissions)).all():
        if permissions and KEY in permissions:
            bind.execute(roles.update().where(roles.c.id == role_id).values(
                permissions={k: v for k, v in permissions.items() if k != KEY}))

    with op.batch_alter_table("users", schema=None) as batch_op:
        batch_op.drop_column(KEY)
