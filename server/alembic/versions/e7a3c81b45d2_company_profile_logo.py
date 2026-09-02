"""company profile: website, and the logo that white-labels the console

Revision ID: e7a3c81b45d2
Revises: d5f29b41c7ea
Create Date: 2026-08-31 16:20:00.000000

Three nullable columns on ``organizations``. Additive and reversible, and every
existing tenant reads exactly as it did before: a NULL ``logo_key`` means "no
logo", which is the state every company is in until somebody uploads one, and
the console falls back to the product mark for it.

``logo_updated_at`` is not derivable from ``updated_at``. The logo is served
from one unchanging URL per tenant, so the console needs a value that changes
*only* when the image does — hanging cache-busting off the row's general
timestamp would re-download the logo every time somebody edited the postcode.

Nothing is backfilled and no file is touched. The stored object a ``logo_key``
points at is written by the upload endpoint, and a downgrade deliberately leaves
those objects in storage rather than deleting customer files on a schema
rollback — they are orphaned, not lost, and re-running the upgrade would not
bring back anything this had removed.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'e7a3c81b45d2'
down_revision: Union[str, None] = 'd5f29b41c7ea'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('organizations') as batch:
        batch.add_column(sa.Column('website', sa.String(length=255), nullable=True))
        batch.add_column(sa.Column('logo_key', sa.String(length=512), nullable=True))
        batch.add_column(
            sa.Column('logo_updated_at', sa.DateTime(timezone=True), nullable=True)
        )


def downgrade() -> None:
    with op.batch_alter_table('organizations') as batch:
        batch.drop_column('logo_updated_at')
        batch.drop_column('logo_key')
        batch.drop_column('website')
