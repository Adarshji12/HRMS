"""quotation setup

Revision ID: e3b9f6a1c527
Revises: d7a4c2e9b815
Create Date: 2026-10-28 12:00:00.000000

Everything the quotation screen in CRM Settings holds beyond the prefix, terms
and validity that already had columns: the style, the letterhead, payment
details, footer, signatory, logo and stamp, the number format and the default
GST rate. One JSON document rather than twenty columns — it is read and written
as a whole, by one screen, and validated by one schema
(``schemas.crm.QuotationSetup``). Empty for every existing workspace, which
means "the defaults": numbering and tax behave exactly as before.
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'e3b9f6a1c527'
down_revision: Union[str, None] = 'd7a4c2e9b815'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('crm_settings', schema=None) as batch_op:
        batch_op.add_column(
            sa.Column('quotation_setup', sa.JSON(), nullable=False, server_default='{}')
        )


def downgrade() -> None:
    with op.batch_alter_table('crm_settings', schema=None) as batch_op:
        batch_op.drop_column('quotation_setup')
