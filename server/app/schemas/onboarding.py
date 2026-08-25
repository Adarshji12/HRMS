"""Request/response shapes for onboarding templates, instances and documents.

Two things here are worth reading before you use them.

**Templates and instances have separate schemas even where the fields look
identical.** ``OnboardingTemplateTaskOut`` and ``OnboardingTaskOut`` differ by
``due_offset_days`` versus ``due_date``, and that difference is the whole
template-vs-instance split showing through the API: a blueprint carries an
offset because it cannot know a date, a hire's task carries the concrete date
resolved from their joining day. Collapsing them into one schema would invite a
handler to write an offset onto a live task, which is exactly the coupling the
model layer refuses.

**``OnboardingInstanceDetailOut`` nests the whole checklist.** The HR pipeline
opens a hire and needs every task grouped by category, plus the documents, in
one call. Anything less is an N+1 against a page that is always opened.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime

from pydantic import BaseModel, Field

from app.schemas.common import ORMModel

#: Shared with the model-layer enums. Written out as regex rather than derived
#: from the enum because that is how every other schema in this codebase states
#: its constraint, and a literal pattern is what shows up in the OpenAPI doc.
CATEGORY_PATTERN = r"^(documentation|it_setup|training|compliance|other)$"
OWNER_ROLE_PATTERN = r"^(hr|manager|it|employee)$"
TASK_STATUS_PATTERN = r"^(pending|in_progress|done|skipped)$"
INSTANCE_STATUS_PATTERN = r"^(pending_setup|in_progress|completed|cancelled)$"


# --------------------------------------------------------------------------- #
# Template tasks — the blueprint rows
# --------------------------------------------------------------------------- #


class OnboardingTemplateTaskIn(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    description: str | None = Field(default=None, max_length=4000)
    category: str = Field(default="other", pattern=CATEGORY_PATTERN)
    owner_role: str = Field(default="hr", pattern=OWNER_ROLE_PATTERN)
    # Negative = before the joining date (pre-boarding). Bounded at a year
    # either side: anything outside that is a typo, not a policy.
    due_offset_days: int = Field(default=0, ge=-365, le=365)
    sort_order: int = Field(default=0, ge=0, le=10_000)
    requires_document: bool = False
    doc_type: str | None = Field(default=None, max_length=64)


class OnboardingTemplateTaskOut(ORMModel):
    id: uuid.UUID
    template_id: uuid.UUID
    title: str
    description: str | None = None
    category: str
    owner_role: str
    due_offset_days: int
    sort_order: int
    requires_document: bool = False
    doc_type: str | None = None


# --------------------------------------------------------------------------- #
# Templates
# --------------------------------------------------------------------------- #


class OnboardingTemplateIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=4000)
    #: None = applies to every department. That is the org-wide fallback, not
    #: "unassigned", so leaving it empty is a deliberate and common choice.
    department_id: uuid.UUID | None = None
    is_active: bool = True
    #: Tasks sent with the template, so building a checklist is one round trip.
    #: Omitted (not empty) means "leave the existing tasks alone" on an update;
    #: an empty list means "this template has no tasks".
    tasks: list[OnboardingTemplateTaskIn] | None = None


class OnboardingTemplateOut(ORMModel):
    id: uuid.UUID
    name: str
    description: str | None = None
    department_id: uuid.UUID | None = None
    is_active: bool
    created_at: datetime

    # Derived, so the template list table needs no client-side joins.
    department_name: str | None = None
    task_count: int = 0
    #: How many hires have ever been started from this template. The reason an
    #: admin gets a confirmation before deleting one.
    instance_count: int = 0


class OnboardingTemplateDetailOut(OnboardingTemplateOut):
    """Template plus its tasks, for the checklist editor."""

    tasks: list[OnboardingTemplateTaskOut] = []


# --------------------------------------------------------------------------- #
# Instance tasks — the instantiated copies
# --------------------------------------------------------------------------- #


class OnboardingTaskIn(BaseModel):
    """Create or edit one task on a live checklist.

    Carries a concrete ``due_date``, never an offset: by the time a task exists
    on an instance the joining date has already been applied, and letting a
    caller send an offset here would silently re-resolve dates the checklist
    has been operating on.
    """

    title: str = Field(min_length=1, max_length=300)
    description: str | None = Field(default=None, max_length=4000)
    category: str = Field(default="other", pattern=CATEGORY_PATTERN)
    owner_role: str = Field(default="hr", pattern=OWNER_ROLE_PATTERN)
    due_date: date | None = None
    sort_order: int = Field(default=0, ge=0, le=10_000)
    assignee_user_id: uuid.UUID | None = None
    requires_document: bool = False
    doc_type: str | None = Field(default=None, max_length=64)


class OnboardingTaskStatusIn(BaseModel):
    """Tick a task off, or mark it not applicable.

    Separate from ``OnboardingTaskIn`` because it is a different authorisation:
    the task's owner may complete it without being allowed to rewrite its title
    or move its deadline.
    """

    status: str = Field(pattern=TASK_STATUS_PATTERN)
    #: Required by the handler when status is "skipped" — a skip with no reason
    #: is worthless to whoever audits the checklist later.
    notes: str | None = Field(default=None, max_length=4000)


class OnboardingTaskOut(ORMModel):
    id: uuid.UUID
    instance_id: uuid.UUID
    title: str
    description: str | None = None
    category: str
    owner_role: str
    sort_order: int
    due_date: date | None = None
    status: str
    assignee_user_id: uuid.UUID | None = None
    completed_by: uuid.UUID | None = None
    completed_at: datetime | None = None
    notes: str | None = None
    requires_document: bool = False
    doc_type: str | None = None
    created_at: datetime

    # Derived display fields.
    #: ``assignee_name``, matching ``TaskOut`` in ``schemas/project.py`` and
    #: the key ``api/v1/projects.py`` already builds. One spelling for one
    #: concept across every task table — see the model column's comment.
    assignee_name: str | None = None
    completed_by_name: str | None = None
    #: Computed against the org's local today by the service — the schema has
    #: no timezone, so it must not try to work this out itself.
    is_overdue: bool = False
    #: Documents already uploaded against this task, so a "requires_document"
    #: row can render its evidence without a second call.
    document_count: int = 0


class OnboardingTaskGroupOut(BaseModel):
    """One category's worth of tasks in the grouped checklist view.

    A list of groups rather than a ``dict[str, list[...]]`` because the console
    renders the categories in a fixed order (documentation, IT, training,
    compliance, other) and JSON objects give no ordering guarantee across
    clients. The group also carries its own counts, so the section header does
    not have to be computed by summing in the browser.
    """

    category: str = Field(pattern=CATEGORY_PATTERN)
    tasks: list[OnboardingTaskOut] = []
    total: int = 0
    completed: int = 0
    overdue: int = 0


# --------------------------------------------------------------------------- #
# Documents
# --------------------------------------------------------------------------- #


class OnboardingDocumentIn(BaseModel):
    """Metadata accompanying an upload.

    Metadata only — the file itself arrives as multipart and goes straight to
    ``services/storage.py``. Bytes never travel through a Pydantic model and
    never reach the database.
    """

    doc_type: str = Field(min_length=1, max_length=64)
    #: The checklist task this file answers, when it answers one.
    task_id: uuid.UUID | None = None


class OnboardingDocumentVerifyIn(BaseModel):
    verified: bool = True
    verification_note: str | None = Field(default=None, max_length=2000)


class OnboardingDocumentOut(ORMModel):
    id: uuid.UUID
    instance_id: uuid.UUID
    task_id: uuid.UUID | None = None
    doc_type: str
    file_name: str
    content_type: str
    file_size: int
    uploaded_by: uuid.UUID | None = None
    verified_by: uuid.UUID | None = None
    verified_at: datetime | None = None
    verification_note: str | None = None
    created_at: datetime

    # Derived display fields.
    uploaded_by_name: str | None = None
    verified_by_name: str | None = None
    is_verified: bool = False

    # storage_key is deliberately absent. It is an internal handle to the
    # storage backend; the client gets a download endpoint that re-checks
    # permission, never a key it could replay or guess neighbours of.


# --------------------------------------------------------------------------- #
# Instances
# --------------------------------------------------------------------------- #


class OnboardingInstanceIn(BaseModel):
    """Start a checklist for a hire.

    ``template_id`` is optional: an ad-hoc checklist with hand-added tasks is
    legitimate, and so is letting the service pick the template that matches
    the hire's department.
    """

    user_id: uuid.UUID
    template_id: uuid.UUID | None = None
    #: Optional so it can default to the user's ``joined_on``. Once set it is
    #: this instance's own anchor — see the model.
    joining_date: date | None = None
    notes: str | None = Field(default=None, max_length=4000)


class OnboardingInstanceUpdateIn(BaseModel):
    status: str | None = Field(default=None, pattern=INSTANCE_STATUS_PATTERN)
    #: Moving this reschedules every *open* task by the same delta. Completed
    #: tasks keep their dates: they record what actually happened.
    joining_date: date | None = None
    notes: str | None = Field(default=None, max_length=4000)


class OnboardingInstanceOut(ORMModel):
    id: uuid.UUID
    user_id: uuid.UUID
    template_id: uuid.UUID | None = None
    template_name: str | None = None
    joining_date: date
    status: str
    started_at: datetime | None = None
    completed_at: datetime | None = None
    notes: str | None = None
    created_at: datetime

    # Derived, so the pipeline table needs no client-side joins.
    user_name: str | None = None
    user_email: str | None = None
    department_name: str | None = None
    designation_name: str | None = None
    manager_name: str | None = None

    total_tasks: int = 0
    #: DONE only. Skipped tasks are counted in ``closed_tasks`` instead, so the
    #: HR view can show "8 done, 2 not applicable" rather than pretending a
    #: skip was work.
    completed_tasks: int = 0
    closed_tasks: int = 0
    overdue_tasks: int = 0
    documents_pending_verification: int = 0

    @property
    def progress_pct(self) -> int:
        if not self.total_tasks:
            return 0
        return round(self.closed_tasks * 100 / self.total_tasks)


class OnboardingInstanceDetailOut(OnboardingInstanceOut):
    """One hire's full checklist: every task grouped by category, plus files.

    The HR pipeline view opens straight into this, so it is built to be the
    only request that page makes. ``groups`` covers the same tasks the flat
    counts on the parent summarise; nothing is served twice in a flat list as
    well, because a checklist of forty tasks does not need sending twice.
    """

    groups: list[OnboardingTaskGroupOut] = []
    documents: list[OnboardingDocumentOut] = []
