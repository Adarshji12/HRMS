"""named roles: per-company permission sets with an explicit data scope

Revision ID: d5f29b41c7ea
Revises: c4e18a72d9f3
Create Date: 2026-08-27 15:05:00.000000

Additive, and every existing user keeps answering exactly as they did.

``users.role_id`` is NULL for everybody after this runs, and ``User.has()``
falls through to the nineteen columns in that case. That is not a migration
left half-done — a NULL role is a permanent, legal state meaning "this person's
permissions are their own", which is how a genuine exception is expressed. The
columns are therefore not dropped, now or later.

The built-in roles (Owner / Administrator / Manager / Employee) are seeded per
organisation by ``services.roles.ensure_builtins``, not here. Seeding in a
migration would mean a permission added to the product in six months has no way
to reach a tenant that migrated today, and it would have to duplicate the
default permission map that already lives in the service.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'd5f29b41c7ea'
down_revision: Union[str, None] = 'c4e18a72d9f3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'org_roles',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('org_id', sa.Uuid(), nullable=False),
        sa.Column('name', sa.String(length=80), nullable=False),
        sa.Column('description', sa.String(length=300), nullable=True),
        sa.Column('base_role', sa.String(length=20), nullable=False,
                  server_default='employee'),
        sa.Column('data_scope', sa.String(length=20), nullable=False,
                  server_default='self'),
        sa.Column('permissions', sa.JSON(), nullable=False),
        sa.Column('is_builtin', sa.Boolean(), nullable=False,
                  server_default=sa.false()),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], ondelete='CASCADE',
                                name=op.f('fk_org_roles_org_id_organizations')),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_org_roles')),
        sa.UniqueConstraint('org_id', 'name', name='uq_org_roles_org_name'),
    )
    op.create_index(op.f('ix_org_roles_org_id'), 'org_roles', ['org_id'])

    # SET NULL rather than CASCADE: deleting a role must not delete the people
    # who held it. They fall back to their own columns, which is a survivable
    # state — losing the employee is not.
    with op.batch_alter_table('users') as batch:
        batch.add_column(sa.Column('role_id', sa.Uuid(), nullable=True))
        batch.add_column(sa.Column('permission_overrides', sa.JSON(), nullable=True))
        batch.create_foreign_key(
            'fk_users_role_id_org_roles', 'org_roles', ['role_id'], ['id'],
            ondelete='SET NULL',
        )
    op.create_index(op.f('ix_users_role_id'), 'users', ['role_id'])


def downgrade() -> None:
    op.drop_index(op.f('ix_users_role_id'), table_name='users')
    with op.batch_alter_table('users') as batch:
        batch.drop_constraint('fk_users_role_id_org_roles', type_='foreignkey')
        batch.drop_column('permission_overrides')
        batch.drop_column('role_id')
    op.drop_index(op.f('ix_org_roles_org_id'), table_name='org_roles')
    op.drop_table('org_roles')
