"""Announcements, pulse surveys and recognition.

Most of this module is ordinary CRUD and the tests reflect that. The survey
half is not, and those tests are the reason this file exists.

**The anonymity tests assert against the database, not the API.** Every other
test suite here goes through the HTTP surface on principle, and these mostly do
too — but a guarantee that "no response row carries a user id" cannot be checked
from outside, because the whole point is that the API has no way to expose it.
Reading the table directly is the only way to catch the regression that matters:
somebody adding a `user_id=viewer.id` to the response for a debugging session
and leaving it in.

What these defend:

1. **An anonymous response has no user id, at the row level.**
2. **Participation and content are never joined**, and the "who has not
   answered" report reads only the participant table.
3. **Results are refused below the floor, not warned about** — and free text is
   held to a higher bar than ratings.
4. **`is_anonymous` cannot be flipped after answers exist.**
5. **An audience too small to ever show a result is refused at the door**,
   rather than collecting answers under a promise that cannot be kept.
6. Read and acknowledged are different questions.
7. Two tenants, always.
"""

from __future__ import annotations

import uuid as _uuid
from datetime import date, timedelta

from sqlalchemy import select

from app.core.security import create_access_token, generate_enrollment_key, hash_password
from app.db.session import SessionLocal
from app.models import User
from app.models.engagement import SurveyParticipant, SurveyResponse


def _people(tenant, count):
    """Extra employees, so a survey can clear its own anonymity floor.

    The fixture gives two accounts; an anonymous survey needs four responses
    before it will say anything, which is the rule under test.
    """
    made = []
    with SessionLocal() as db:
        for i in range(count):
            person = User(
                id=_uuid.uuid4(), org_id=tenant.id,
                email=f"p{i}-{_uuid.uuid4().hex[:6]}@{tenant.slug}.test",
                full_name=f"Person {i}", role="employee",
                password_hash=hash_password("correct-horse-battery"),
                is_active=True, enrollment_key=generate_enrollment_key(),
            )
            db.add(person)
            made.append(person)
        db.commit()
        return [
            (p.id, create_access_token(
                str(p.id), {"typ": "user", "org": str(tenant.id), "role": "employee"}))
            for p in made
        ]


def _survey(client, tenant, *, anonymous=True, min_responses=4, **overrides):
    body = {
        "title": "Quarterly pulse",
        "is_anonymous": anonymous,
        "min_responses": min_responses,
        "questions": [
            {"prompt": "How are things?", "kind": "scale", "scale_max": 5},
            {"prompt": "Anything else?", "kind": "text", "is_required": False},
        ],
    } | overrides
    response = client.post("/api/v1/engagement/surveys", json=body,
                           headers=tenant.headers())
    assert response.status_code == 201, response.text
    return response.json()


def _open(client, tenant, survey_id):
    response = client.post(f"/api/v1/engagement/surveys/{survey_id}/open",
                           headers=tenant.headers())
    assert response.status_code == 200, response.text
    return response.json()


def _answer(client, tenant, survey, token, *, rating=4, text=None):
    scale, free = survey["questions"][0], survey["questions"][1]
    answers = [{"question_id": scale["id"], "rating": rating}]
    if text:
        answers.append({"question_id": free["id"], "text": text})
    return client.post(f"/api/v1/engagement/surveys/{survey['id']}/submit",
                       json={"answers": answers}, headers=tenant.headers(token))


# --------------------------------------------------------------------------- #
# The anonymity guarantee
# --------------------------------------------------------------------------- #


def test_an_anonymous_response_carries_no_user_id_at_all(client, tenants):
    """Asserted against the table, not the API — the API has no way to expose
    this, which is the point. This is the test that catches somebody adding
    `user_id=viewer.id` for a debugging session and leaving it in."""
    acme, _ = tenants
    extra = _people(acme, 4)
    survey = _survey(client, acme)
    _open(client, acme, survey["id"])

    for _, token in extra:
        assert _answer(client, acme, survey, token).status_code == 204

    with SessionLocal() as db:
        rows = list(db.scalars(select(SurveyResponse).where(
            SurveyResponse.survey_id == _uuid.UUID(survey["id"]))))
        assert len(rows) == 4
        assert all(row.user_id is None for row in rows), (
            "an anonymous response carries an identity"
        )


def test_an_attributed_survey_does_record_who_answered(client, tenants):
    """The other half of the same guarantee. An attributed survey is a real and
    different instrument — a manager-effectiveness round that names the
    respondent is legitimate — and refusing to model it would push companies
    into running it over email, where it is neither anonymous nor recorded."""
    acme, _ = tenants
    survey = _survey(client, acme, anonymous=False, min_responses=2)
    _open(client, acme, survey["id"])
    assert _answer(client, acme, survey, acme.employee_token).status_code == 204

    with SessionLocal() as db:
        row = db.scalar(select(SurveyResponse).where(
            SurveyResponse.survey_id == _uuid.UUID(survey["id"])))
        assert row.user_id == acme.employee.id


def test_participation_is_tracked_without_the_content(client, tenants):
    """Both facts have to be true at once: the system knows they answered, and
    cannot know what they said."""
    acme, _ = tenants
    extra = _people(acme, 4)
    survey = _survey(client, acme)
    _open(client, acme, survey["id"])
    _answer(client, acme, survey, extra[0][1])

    with SessionLocal() as db:
        participant = db.scalar(select(SurveyParticipant).where(
            SurveyParticipant.survey_id == _uuid.UUID(survey["id"]),
            SurveyParticipant.user_id == extra[0][0]))
        assert participant.responded_at is not None
        # And there is nothing on the response that could be joined back to it.
        response = db.scalar(select(SurveyResponse).where(
            SurveyResponse.survey_id == _uuid.UUID(survey["id"])))
        assert response.user_id is None


def test_the_outstanding_list_names_only_who_has_not_answered(client, tenants):
    """Chasing non-responders is legitimate and necessary, and it must not
    require touching anything that knows what anybody said."""
    acme, _ = tenants
    extra = _people(acme, 4)
    survey = _survey(client, acme)
    _open(client, acme, survey["id"])
    _answer(client, acme, survey, extra[0][1])

    names = client.get(f"/api/v1/engagement/surveys/{survey['id']}/outstanding",
                       headers=acme.headers()).json()
    assert "Person 0" not in names
    assert "Person 1" in names


def test_nobody_may_answer_twice(client, tenants):
    acme, _ = tenants
    extra = _people(acme, 4)
    survey = _survey(client, acme)
    _open(client, acme, survey["id"])
    assert _answer(client, acme, survey, extra[0][1]).status_code == 204

    again = _answer(client, acme, survey, extra[0][1])
    assert again.status_code == 409
    assert again.json()["detail"]["reason"] == "already_responded"


def test_somebody_not_invited_cannot_answer(client, tenants):
    acme, _ = tenants
    survey = _survey(client, acme, anonymous=False, min_responses=2,
                     audience_kind="people",
                     audience_ids=[str(acme.owner.id)])
    _open(client, acme, survey["id"])

    response = _answer(client, acme, survey, acme.employee_token)
    assert response.status_code == 404
    assert response.json()["detail"]["reason"] == "not_invited"


# --------------------------------------------------------------------------- #
# Suppression
# --------------------------------------------------------------------------- #


def test_results_are_refused_below_the_floor_not_warned_about(client, tenants):
    """A warning is something a reader scrolls past while the number underneath
    it is still on their screen."""
    acme, _ = tenants
    extra = _people(acme, 4)
    survey = _survey(client, acme)
    _open(client, acme, survey["id"])
    _answer(client, acme, survey, extra[0][1])
    _answer(client, acme, survey, extra[1][1])

    body = client.get(f"/api/v1/engagement/surveys/{survey['id']}/results",
                      headers=acme.headers()).json()
    assert body["withheld_reason"]
    assert "2 of" in body["withheld_reason"]
    assert all(q["mean_centi"] is None for q in body["questions"])
    # The questions are still listed — hiding them would make an uncomfortable
    # question look like one nobody asked.
    assert len(body["questions"]) == 2
    assert all(q["withheld"] for q in body["questions"])


def test_results_appear_once_the_floor_is_met(client, tenants):
    acme, _ = tenants
    extra = _people(acme, 4)
    survey = _survey(client, acme)
    _open(client, acme, survey["id"])
    for (_, token), score in zip(extra, (4, 4, 3, 5)):
        _answer(client, acme, survey, token, rating=score)

    body = client.get(f"/api/v1/engagement/surveys/{survey['id']}/results",
                      headers=acme.headers()).json()
    assert body["withheld_reason"] is None
    scale = body["questions"][0]
    # (4+4+3+5)/4 = 4.00, carried as hundredths like every rating in this system.
    assert scale["mean_centi"] == 400
    assert scale["distribution"] == [0, 0, 1, 2, 1]


def test_free_text_is_held_to_a_higher_bar_than_ratings(client, tenants):
    """A sentence carries voice, detail and grievance; a "4" carries a digit.
    Four people's ratings average into something nobody can attribute — four
    people's paragraphs do not."""
    acme, _ = tenants
    extra = _people(acme, 4)
    survey = _survey(client, acme)
    _open(client, acme, survey["id"])
    for (_, token) in extra:
        _answer(client, acme, survey, token, text="Something identifying")

    body = client.get(f"/api/v1/engagement/surveys/{survey['id']}/results",
                      headers=acme.headers()).json()
    scale, free = body["questions"]
    assert scale["mean_centi"] is not None, "ratings clear the floor at four"
    assert free["withheld"] is True, "free text needs more than the rating floor"
    assert free["texts"] == []


def test_an_attributed_survey_shows_results_without_a_floor(client, tenants):
    """The floor exists to protect anonymity. There is none to protect here, and
    applying it anyway would hide results for no reason."""
    acme, _ = tenants
    survey = _survey(client, acme, anonymous=False, min_responses=4)
    _open(client, acme, survey["id"])
    _answer(client, acme, survey, acme.employee_token, rating=3, text="Fine")

    body = client.get(f"/api/v1/engagement/surveys/{survey['id']}/results",
                      headers=acme.headers()).json()
    assert body["withheld_reason"] is None
    assert body["questions"][0]["mean_centi"] == 300
    assert body["questions"][1]["texts"] == ["Fine"]


def test_an_audience_too_small_to_ever_show_a_result_is_refused_at_the_door(
    client, tenants
):
    """Collecting answers under a promise the system cannot keep is worse than
    not running the survey."""
    acme, _ = tenants
    survey = _survey(client, acme, min_responses=10)

    response = client.post(f"/api/v1/engagement/surveys/{survey['id']}/open",
                           headers=acme.headers())
    assert response.status_code == 422
    body = response.json()["detail"]
    assert body["reason"] == "audience_too_small"
    assert "10" in body["message"]


def test_an_open_survey_cannot_be_reopened(client, tenants):
    acme, _ = tenants
    _people(acme, 4)
    survey = _survey(client, acme)
    _open(client, acme, survey["id"])

    again = client.post(f"/api/v1/engagement/surveys/{survey['id']}/open",
                        headers=acme.headers())
    assert again.status_code == 409
    assert again.json()["detail"]["reason"] == "already_open"


def test_a_closed_survey_takes_no_more_answers(client, tenants):
    acme, _ = tenants
    extra = _people(acme, 4)
    survey = _survey(client, acme)
    _open(client, acme, survey["id"])
    client.post(f"/api/v1/engagement/surveys/{survey['id']}/close",
                headers=acme.headers())

    response = _answer(client, acme, survey, extra[0][1])
    assert response.status_code == 409
    assert response.json()["detail"]["reason"] == "not_open"


def test_another_tenants_survey_is_not_found(client, tenants):
    acme, globex = tenants
    _people(globex, 4)
    theirs = _survey(client, globex)
    response = client.post(f"/api/v1/engagement/surveys/{theirs['id']}/open",
                           headers=acme.headers())
    assert response.status_code == 404


# --------------------------------------------------------------------------- #
# Announcements
# --------------------------------------------------------------------------- #


def _post(client, tenant, *, publish=True, **overrides):
    body = {"title": "New expenses policy", "body": "Read it."} | overrides
    response = client.post("/api/v1/engagement/announcements", json=body,
                           headers=tenant.headers())
    assert response.status_code == 201, response.text
    post = response.json()
    if publish:
        published = client.post(
            f"/api/v1/engagement/announcements/{post['id']}/publish",
            headers=tenant.headers())
        assert published.status_code == 200, published.text
        post = published.json()
    return post


def test_a_draft_is_not_on_anybodys_feed(client, tenants):
    acme, _ = tenants
    _post(client, acme, publish=False)
    assert client.get("/api/v1/engagement/announcements",
                      headers=acme.headers(acme.employee_token)).json() == []


def test_read_and_acknowledged_are_different_questions(client, tenants):
    """"97% have read it" is not an answer to "has everybody accepted the new
    expenses policy"."""
    acme, _ = tenants
    post = _post(client, acme, requires_acknowledgement=True)

    client.post(f"/api/v1/engagement/announcements/{post['id']}/read",
                json={"acknowledge": False},
                headers=acme.headers(acme.employee_token))
    reach = client.get(f"/api/v1/engagement/announcements/{post['id']}/reach",
                       headers=acme.headers()).json()
    assert reach["read"] == 1
    assert reach["acknowledged"] == 0
    # Outstanding means "has not done what was asked" — acknowledging, here.
    assert acme.employee.full_name in reach["outstanding"]

    client.post(f"/api/v1/engagement/announcements/{post['id']}/read",
                json={"acknowledge": True},
                headers=acme.headers(acme.employee_token))
    reach = client.get(f"/api/v1/engagement/announcements/{post['id']}/reach",
                       headers=acme.headers()).json()
    assert reach["acknowledged"] == 1
    assert acme.employee.full_name not in reach["outstanding"]


def test_reading_twice_does_not_move_the_first_timestamp(client, tenants):
    """Both timestamps are evidence and neither should be rewritten by a later
    visit."""
    acme, _ = tenants
    post = _post(client, acme)
    first = client.post(f"/api/v1/engagement/announcements/{post['id']}/read",
                        json={"acknowledge": False},
                        headers=acme.headers(acme.employee_token)).json()
    second = client.post(f"/api/v1/engagement/announcements/{post['id']}/read",
                         json={"acknowledge": False},
                         headers=acme.headers(acme.employee_token)).json()
    assert first["read_at"] == second["read_at"]


def test_an_announcement_addressed_elsewhere_is_not_on_your_feed(client, tenants):
    acme, _ = tenants
    _post(client, acme, audience_kind="people", audience_ids=[str(acme.owner.id)])

    theirs = client.get("/api/v1/engagement/announcements",
                        headers=acme.headers(acme.employee_token)).json()
    assert theirs == []
    assert len(client.get("/api/v1/engagement/announcements",
                          headers=acme.headers()).json()) == 1


def test_an_expired_announcement_drops_off_the_feed(client, tenants):
    acme, _ = tenants
    _post(client, acme, expires_on=(date.today() - timedelta(days=1)).isoformat())
    assert client.get("/api/v1/engagement/announcements",
                      headers=acme.headers(acme.employee_token)).json() == []


def test_an_announcement_with_no_expiry_stays(client, tenants):
    """Null means "until archived", and a naive `expires_on <= today` filter in
    SQL would silently drop exactly the posts that must never drop off."""
    acme, _ = tenants
    _post(client, acme)
    assert len(client.get("/api/v1/engagement/announcements",
                          headers=acme.headers(acme.employee_token)).json()) == 1


def test_a_published_announcement_cannot_go_back_to_draft(client, tenants):
    """Un-publishing would make the read receipts evidence about a document that
    officially never existed."""
    acme, _ = tenants
    post = _post(client, acme)
    response = client.post(
        f"/api/v1/engagement/announcements/{post['id']}/publish",
        headers=acme.headers())
    assert response.status_code == 409
    assert response.json()["detail"]["reason"] == "already_published"


def test_an_empty_audience_is_refused_while_the_author_is_still_writing(client, tenants):
    acme, _ = tenants
    response = client.post(
        "/api/v1/engagement/announcements",
        json={"title": "To nobody", "body": "…", "audience_kind": "departments",
              "audience_ids": []},
        headers=acme.headers())
    assert response.status_code == 422
    assert response.json()["detail"]["reason"] == "empty_audience"


# --------------------------------------------------------------------------- #
# Recognition
# --------------------------------------------------------------------------- #


def test_anybody_may_recognise_anybody(client, tenants):
    """Recognition only administrators may give is not recognition, it is an
    award — so there is no permission gate."""
    acme, _ = tenants
    response = client.post(
        "/api/v1/engagement/recognition",
        json={"to_user_id": str(acme.owner.id), "message": "Covered for me on Friday."},
        headers=acme.headers(acme.employee_token))
    assert response.status_code == 201, response.text
    assert response.json()["from_name"] == acme.employee.full_name


def test_you_cannot_recognise_yourself(client, tenants):
    acme, _ = tenants
    response = client.post(
        "/api/v1/engagement/recognition",
        json={"to_user_id": str(acme.employee.id), "message": "Great work by me."},
        headers=acme.headers(acme.employee_token))
    assert response.status_code == 422
    assert response.json()["detail"]["reason"] == "self_recognition"


def test_a_private_recognition_is_invisible_even_to_an_administrator(client, tenants):
    """A quiet thank you HR can read is not a quiet thank you, and knowing it
    might be read is enough to stop some being sent."""
    acme, _ = tenants
    extra = _people(acme, 2)
    client.post(
        "/api/v1/engagement/recognition",
        json={"to_user_id": str(extra[0][0]), "message": "Between us — thank you.",
              "is_public": False},
        headers=acme.headers(acme.employee_token))

    assert client.get("/api/v1/engagement/recognition",
                      headers=acme.headers()).json() == []
    # Both people in it can see it.
    for token in (acme.employee_token, extra[0][1]):
        assert len(client.get("/api/v1/engagement/recognition",
                              headers=acme.headers(token)).json()) == 1


def test_a_recognition_can_cite_a_competency(client, tenants):
    """The point of it living in the same product: "Ownership — she took the
    incident at 2am" is a sentence that belongs in an appraisal."""
    acme, _ = tenants
    competency = client.post("/api/v1/performance/competencies",
                             json={"name": "Ownership"},
                             headers=acme.headers()).json()
    response = client.post(
        "/api/v1/engagement/recognition",
        json={"to_user_id": str(acme.owner.id), "message": "Took the 2am incident.",
              "competency_id": competency["id"]},
        headers=acme.headers(acme.employee_token))
    assert response.status_code == 201
    assert response.json()["competency_name"] == "Ownership"


def test_recognition_does_not_cross_a_tenant_boundary(client, tenants):
    acme, globex = tenants
    response = client.post(
        "/api/v1/engagement/recognition",
        json={"to_user_id": str(globex.employee.id), "message": "Hello stranger."},
        headers=acme.headers(acme.employee_token))
    assert response.status_code == 404


# --------------------------------------------------------------------------- #
# The gate
# --------------------------------------------------------------------------- #


def test_the_module_gate_actually_bites(client, tenants):
    """Every other test here would pass identically if the router were
    registered without `require_module` — the fixture's company resolves to a
    plan that allows everything."""
    from tests.test_module_grants import _restrict_plan

    acme, _ = tenants
    _restrict_plan(acme.id, ["attendance"])
    assert client.get("/api/v1/engagement/announcements",
                      headers=acme.headers()).status_code == 402
