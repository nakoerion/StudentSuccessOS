-- Success engine slice 3a: action-card lifecycle, "no track change without an approved
-- card", and the cursor of the domain-event relay. Hand-written (Prisma cannot express
-- partial indexes or triggers). Grants for the tables stay in the generated RLS migration.

-- ─── Action cards ────────────────────────────────────────────────────────────

-- At most one open track-transition proposal per student (recomputes are idempotent).
CREATE UNIQUE INDEX "action_card_one_open_track" ON "action_card" ("tenant_id", "subject_person_id")
  WHERE "status" = 'proposed' AND "type" = 'track_transition';

-- A card is born "proposed" and is decided exactly once: approved | edited | dismissed |
-- expired are final, and a decided card's payload cannot be rewritten afterwards.
CREATE OR REPLACE FUNCTION ssos_action_card_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'proposed' THEN
      RAISE EXCEPTION 'action_card_lifecycle: a new action card must be proposed (got %)', NEW.status
        USING ERRCODE = 'check_violation', CONSTRAINT = 'action_card_lifecycle';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'proposed' AND (
       NEW.status IS DISTINCT FROM OLD.status
    OR NEW.decided_payload IS DISTINCT FROM OLD.decided_payload
    OR NEW.proposed_payload IS DISTINCT FROM OLD.proposed_payload
    OR NEW.decided_at IS DISTINCT FROM OLD.decided_at
    OR NEW.decided_by_person_id IS DISTINCT FROM OLD.decided_by_person_id) THEN
    RAISE EXCEPTION 'action_card_lifecycle: action card % is already %', OLD.id, OLD.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'action_card_lifecycle';
  END IF;
  IF NEW.type IS DISTINCT FROM OLD.type OR NEW.subject_person_id IS DISTINCT FROM OLD.subject_person_id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION 'action_card_lifecycle: type, subject and tenant of an action card are immutable'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'action_card_lifecycle';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "action_card_guard"
  BEFORE INSERT OR UPDATE ON "action_card"
  FOR EACH ROW EXECUTE FUNCTION ssos_action_card_guard();

-- ─── Track assignments: only an approved card can change a track ─────────────

-- One assignment per card.
CREATE UNIQUE INDEX "track_assignment_one_per_card" ON "track_assignment" ("tenant_id", "action_card_id");

-- INSERT needs an approved/edited track_transition card about the same student whose
-- (decided, else proposed) payload names the same track. UPDATE may only retire an
-- active assignment (active -> superseded | ended) or move its review date.
CREATE OR REPLACE FUNCTION ssos_track_assignment_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  c record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.action_card_id IS NULL THEN
      RAISE EXCEPTION 'track_assignment_requires_approved_card: a track can only change through an approved action card'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'track_assignment_requires_approved_card';
    END IF;
    SELECT type, status, subject_person_id, COALESCE(decided_payload, proposed_payload) ->> 'track' AS track
      INTO c
      FROM action_card
     WHERE tenant_id = NEW.tenant_id AND id = NEW.action_card_id;
    IF NOT FOUND
       OR c.type <> 'track_transition'
       OR c.status NOT IN ('approved', 'edited')
       OR c.subject_person_id <> NEW.student_person_id
       OR c.track IS DISTINCT FROM NEW.track::text THEN
      RAISE EXCEPTION 'track_assignment_requires_approved_card: card % is not an approved track transition to % for this student', NEW.action_card_id, NEW.track
        USING ERRCODE = 'check_violation', CONSTRAINT = 'track_assignment_requires_approved_card';
    END IF;
    IF NEW.status <> 'active' THEN
      RAISE EXCEPTION 'track_assignment_requires_approved_card: a new track assignment must be active'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'track_assignment_requires_approved_card';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.track IS DISTINCT FROM OLD.track
     OR NEW.student_person_id IS DISTINCT FROM OLD.student_person_id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.action_card_id IS DISTINCT FROM OLD.action_card_id
     OR NEW.effective_date IS DISTINCT FROM OLD.effective_date
     OR NEW.confidence IS DISTINCT FROM OLD.confidence
     OR NEW.evidence_refs IS DISTINCT FROM OLD.evidence_refs
     OR (NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status = 'active' AND NEW.status IN ('superseded', 'ended'))) THEN
    RAISE EXCEPTION 'track_assignment_requires_approved_card: track assignment % can only be retired, not rewritten', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'track_assignment_requires_approved_card';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "track_assignment_guard"
  BEFORE INSERT OR UPDATE ON "track_assignment"
  FOR EACH ROW EXECUTE FUNCTION ssos_track_assignment_guard();

-- ─── Domain-event relay cursor ───────────────────────────────────────────────

-- Owner-only bookkeeping for @ssos/jobs: how far the relay has read the `event` table.
-- Its own schema (like pg-boss's), so the app role has no USAGE and RLS templates do not
-- apply; it holds no tenant data.
CREATE SCHEMA IF NOT EXISTS "ssos_jobs";
REVOKE ALL ON SCHEMA "ssos_jobs" FROM PUBLIC;
CREATE TABLE "ssos_jobs"."relay_cursor" (
  "name"            TEXT PRIMARY KEY,
  "last_created_at" TIMESTAMPTZ(6) NOT NULL,
  "last_id"         UUID NOT NULL,
  "updated_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
REVOKE ALL ON "ssos_jobs"."relay_cursor" FROM PUBLIC;

-- The relay reads events in (created_at, id) order by type.
CREATE INDEX "event_created_at_id_idx" ON "event" ("created_at", "id");
