-- CreateEnum
CREATE TYPE "comm_channel" AS ENUM ('whatsapp', 'telegram', 'email', 'sms', 'push');

-- CreateEnum
CREATE TYPE "channel_opt_in_state" AS ENUM ('pending', 'opted_in', 'opted_out');

-- CreateEnum
CREATE TYPE "outbox_state" AS ENUM ('queued', 'sending', 'sent', 'delivered', 'failed', 'dead', 'cancelled');

-- CreateEnum
CREATE TYPE "thread_scope" AS ENUM ('student', 'class_section');

-- CreateEnum
CREATE TYPE "message_direction" AS ENUM ('outbound', 'inbound');

-- CreateEnum
CREATE TYPE "announcement_audience" AS ENUM ('school', 'role', 'class_section');

-- CreateEnum
CREATE TYPE "notification_category" AS ENUM ('alert', 'digest', 'message', 'announcement', 'nudge', 'system');

-- CreateEnum
CREATE TYPE "digest_run_state" AS ENUM ('pending', 'running', 'completed', 'failed');

-- CreateTable
CREATE TABLE "thread" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "scope" "thread_scope" NOT NULL,
    "student_person_id" UUID,
    "class_section_id" UUID,
    "subject" TEXT,
    "created_by_person_id" UUID,
    "last_message_at" TIMESTAMPTZ(6),
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "thread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "thread_id" UUID NOT NULL,
    "direction" "message_direction" NOT NULL DEFAULT 'outbound',
    "author_person_id" UUID,
    "body" TEXT NOT NULL,
    "channel" "comm_channel",
    "channel_binding_id" UUID,
    "external_message_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_binding" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "person_id" UUID NOT NULL,
    "channel" "comm_channel" NOT NULL,
    "external_id" TEXT NOT NULL,
    "opt_in_state" "channel_opt_in_state" NOT NULL DEFAULT 'pending',
    "locale" VARCHAR(8),
    "meta" JSONB NOT NULL DEFAULT '{}',
    "verified_at" TIMESTAMPTZ(6),
    "opted_in_at" TIMESTAMPTZ(6),
    "opted_out_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channel_binding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "channel" "comm_channel" NOT NULL,
    "recipient_person_id" UUID,
    "channel_binding_id" UUID,
    "template" TEXT NOT NULL,
    "locale" VARCHAR(8) NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "state" "outbox_state" NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error" TEXT,
    "provider_message_id" TEXT,
    "idempotency_key" TEXT,
    "notification_id" UUID,
    "message_id" UUID,
    "digest_run_id" UUID,
    "sent_at" TIMESTAMPTZ(6),
    "delivered_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "announcement" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "author_person_id" UUID,
    "audience" "announcement_audience" NOT NULL DEFAULT 'school',
    "audience_role" TEXT,
    "class_section_id" UUID,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "locale" VARCHAR(8) NOT NULL,
    "published_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "announcement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "recipient_person_id" UUID NOT NULL,
    "category" "notification_category" NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "subject_person_id" UUID,
    "alert_id" UUID,
    "announcement_id" UUID,
    "thread_id" UUID,
    "read_at" TIMESTAMPTZ(6),
    "acknowledged_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preference" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "role_key" TEXT,
    "person_id" UUID,
    "category" "notification_category" NOT NULL,
    "channels" "comm_channel"[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "quiet_start_minute" INTEGER,
    "quiet_end_minute" INTEGER,
    "critical_bypasses_quiet" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_preference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "digest_run" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'weekly',
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "state" "digest_run_state" NOT NULL DEFAULT 'pending',
    "stats" JSONB NOT NULL DEFAULT '{}',
    "error" TEXT,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "digest_run_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "thread_tenant_id_idx" ON "thread"("tenant_id");

-- CreateIndex
CREATE INDEX "thread_tenant_id_student_person_id_idx" ON "thread"("tenant_id", "student_person_id");

-- CreateIndex
CREATE INDEX "thread_tenant_id_class_section_id_idx" ON "thread"("tenant_id", "class_section_id");

-- CreateIndex
CREATE INDEX "thread_tenant_id_last_message_at_idx" ON "thread"("tenant_id", "last_message_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "thread_tenant_id_id_key" ON "thread"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "message_tenant_id_idx" ON "message"("tenant_id");

-- CreateIndex
CREATE INDEX "message_tenant_id_thread_id_created_at_idx" ON "message"("tenant_id", "thread_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "message_tenant_id_id_key" ON "message"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "message_tenant_id_channel_external_message_id_key" ON "message"("tenant_id", "channel", "external_message_id");

-- CreateIndex
CREATE INDEX "channel_binding_tenant_id_idx" ON "channel_binding"("tenant_id");

-- CreateIndex
CREATE INDEX "channel_binding_tenant_id_person_id_channel_idx" ON "channel_binding"("tenant_id", "person_id", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "channel_binding_tenant_id_id_key" ON "channel_binding"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "channel_binding_tenant_id_channel_external_id_key" ON "channel_binding"("tenant_id", "channel", "external_id");

-- CreateIndex
CREATE INDEX "outbox_tenant_id_idx" ON "outbox"("tenant_id");

-- CreateIndex
CREATE INDEX "outbox_state_next_attempt_at_idx" ON "outbox"("state", "next_attempt_at");

-- CreateIndex
CREATE INDEX "outbox_tenant_id_recipient_person_id_created_at_idx" ON "outbox"("tenant_id", "recipient_person_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "outbox_tenant_id_provider_message_id_idx" ON "outbox"("tenant_id", "provider_message_id");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_tenant_id_id_key" ON "outbox"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_tenant_id_idempotency_key_key" ON "outbox"("tenant_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "announcement_tenant_id_idx" ON "announcement"("tenant_id");

-- CreateIndex
CREATE INDEX "announcement_tenant_id_published_at_idx" ON "announcement"("tenant_id", "published_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "announcement_tenant_id_id_key" ON "announcement"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "notification_tenant_id_idx" ON "notification"("tenant_id");

-- CreateIndex
CREATE INDEX "notification_tenant_id_recipient_person_id_created_at_idx" ON "notification"("tenant_id", "recipient_person_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "notification_tenant_id_alert_id_idx" ON "notification"("tenant_id", "alert_id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_tenant_id_id_key" ON "notification"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_tenant_id_announcement_id_recipient_person_id_key" ON "notification"("tenant_id", "announcement_id", "recipient_person_id");

-- CreateIndex
CREATE INDEX "notification_preference_tenant_id_idx" ON "notification_preference"("tenant_id");

-- CreateIndex
CREATE INDEX "notification_preference_tenant_id_person_id_idx" ON "notification_preference"("tenant_id", "person_id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_preference_tenant_id_id_key" ON "notification_preference"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "digest_run_tenant_id_idx" ON "digest_run"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "digest_run_tenant_id_id_key" ON "digest_run"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "digest_run_tenant_id_kind_period_start_key" ON "digest_run"("tenant_id", "kind", "period_start");

-- AddForeignKey
ALTER TABLE "thread" ADD CONSTRAINT "thread_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "thread" ADD CONSTRAINT "thread_tenant_id_student_person_id_fkey" FOREIGN KEY ("tenant_id", "student_person_id") REFERENCES "person"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "thread" ADD CONSTRAINT "thread_tenant_id_class_section_id_fkey" FOREIGN KEY ("tenant_id", "class_section_id") REFERENCES "class_section"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "thread" ADD CONSTRAINT "thread_tenant_id_created_by_person_id_fkey" FOREIGN KEY ("tenant_id", "created_by_person_id") REFERENCES "person"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message" ADD CONSTRAINT "message_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message" ADD CONSTRAINT "message_tenant_id_thread_id_fkey" FOREIGN KEY ("tenant_id", "thread_id") REFERENCES "thread"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message" ADD CONSTRAINT "message_tenant_id_author_person_id_fkey" FOREIGN KEY ("tenant_id", "author_person_id") REFERENCES "person"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message" ADD CONSTRAINT "message_tenant_id_channel_binding_id_fkey" FOREIGN KEY ("tenant_id", "channel_binding_id") REFERENCES "channel_binding"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_binding" ADD CONSTRAINT "channel_binding_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_binding" ADD CONSTRAINT "channel_binding_tenant_id_person_id_fkey" FOREIGN KEY ("tenant_id", "person_id") REFERENCES "person"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_tenant_id_recipient_person_id_fkey" FOREIGN KEY ("tenant_id", "recipient_person_id") REFERENCES "person"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_tenant_id_channel_binding_id_fkey" FOREIGN KEY ("tenant_id", "channel_binding_id") REFERENCES "channel_binding"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_tenant_id_notification_id_fkey" FOREIGN KEY ("tenant_id", "notification_id") REFERENCES "notification"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_tenant_id_message_id_fkey" FOREIGN KEY ("tenant_id", "message_id") REFERENCES "message"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_tenant_id_digest_run_id_fkey" FOREIGN KEY ("tenant_id", "digest_run_id") REFERENCES "digest_run"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcement" ADD CONSTRAINT "announcement_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcement" ADD CONSTRAINT "announcement_tenant_id_author_person_id_fkey" FOREIGN KEY ("tenant_id", "author_person_id") REFERENCES "person"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcement" ADD CONSTRAINT "announcement_tenant_id_class_section_id_fkey" FOREIGN KEY ("tenant_id", "class_section_id") REFERENCES "class_section"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "notification_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "notification_tenant_id_recipient_person_id_fkey" FOREIGN KEY ("tenant_id", "recipient_person_id") REFERENCES "person"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "notification_tenant_id_subject_person_id_fkey" FOREIGN KEY ("tenant_id", "subject_person_id") REFERENCES "person"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "notification_tenant_id_alert_id_fkey" FOREIGN KEY ("tenant_id", "alert_id") REFERENCES "alert"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "notification_tenant_id_announcement_id_fkey" FOREIGN KEY ("tenant_id", "announcement_id") REFERENCES "announcement"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "notification_tenant_id_thread_id_fkey" FOREIGN KEY ("tenant_id", "thread_id") REFERENCES "thread"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preference" ADD CONSTRAINT "notification_preference_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preference" ADD CONSTRAINT "notification_preference_tenant_id_person_id_fkey" FOREIGN KEY ("tenant_id", "person_id") REFERENCES "person"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "digest_run" ADD CONSTRAINT "digest_run_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ─── Hand-written: checks, partial indexes and the outbox lifecycle ─────────
-- (Prisma cannot express these. Grants and RLS stay in the generated RLS migration.)

-- A thread is about exactly one student or exactly one class section.
ALTER TABLE "thread" ADD CONSTRAINT "thread_scope_target" CHECK (
  ("scope" = 'student' AND "student_person_id" IS NOT NULL AND "class_section_id" IS NULL)
  OR ("scope" = 'class_section' AND "class_section_id" IS NOT NULL AND "student_person_id" IS NULL));

ALTER TABLE "message" ADD CONSTRAINT "message_body_not_blank" CHECK (length(btrim("body")) > 0);
-- An inbound message always says which channel it came from.
ALTER TABLE "message" ADD CONSTRAINT "message_inbound_has_channel" CHECK ("direction" = 'outbound' OR "channel" IS NOT NULL);

ALTER TABLE "channel_binding" ADD CONSTRAINT "channel_binding_external_id_not_blank" CHECK (length(btrim("external_id")) > 0);
ALTER TABLE "channel_binding" ADD CONSTRAINT "channel_binding_opt_in_stamped" CHECK (
  ("opt_in_state" <> 'opted_in' OR "opted_in_at" IS NOT NULL)
  AND ("opt_in_state" <> 'opted_out' OR "opted_out_at" IS NOT NULL));

ALTER TABLE "outbox" ADD CONSTRAINT "outbox_attempts_range" CHECK ("attempts" >= 0 AND "max_attempts" >= 1 AND "attempts" <= "max_attempts");
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_has_target" CHECK ("recipient_person_id" IS NOT NULL OR "channel_binding_id" IS NOT NULL);
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_template_not_blank" CHECK (length(btrim("template")) > 0);
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_state_stamped" CHECK (
  ("state" NOT IN ('sent', 'delivered') OR "sent_at" IS NOT NULL)
  AND ("state" <> 'delivered' OR "delivered_at" IS NOT NULL));

ALTER TABLE "announcement" ADD CONSTRAINT "announcement_audience_target" CHECK (
  ("audience" = 'school' AND "audience_role" IS NULL AND "class_section_id" IS NULL)
  OR ("audience" = 'role' AND "audience_role" IS NOT NULL AND "class_section_id" IS NULL)
  OR ("audience" = 'class_section' AND "class_section_id" IS NOT NULL AND "audience_role" IS NULL));
ALTER TABLE "announcement" ADD CONSTRAINT "announcement_text_not_blank" CHECK (length(btrim("title")) > 0 AND length(btrim("body")) > 0);

-- A preference is a role default or a person's override, never both.
ALTER TABLE "notification_preference" ADD CONSTRAINT "notification_preference_owner" CHECK (("role_key" IS NULL) <> ("person_id" IS NULL));
ALTER TABLE "notification_preference" ADD CONSTRAINT "notification_preference_quiet_hours" CHECK (
  ("quiet_start_minute" IS NULL AND "quiet_end_minute" IS NULL)
  OR ("quiet_start_minute" BETWEEN 0 AND 1439 AND "quiet_end_minute" BETWEEN 0 AND 1439));
CREATE UNIQUE INDEX "notification_preference_role_category" ON "notification_preference" ("tenant_id", "role_key", "category")
  WHERE "person_id" IS NULL;
CREATE UNIQUE INDEX "notification_preference_person_category" ON "notification_preference" ("tenant_id", "person_id", "category")
  WHERE "person_id" IS NOT NULL;

ALTER TABLE "digest_run" ADD CONSTRAINT "digest_run_period" CHECK ("period_end" >= "period_start");

-- Outbox lifecycle. A row is born queued with no attempts; every move into `sending`
-- counts exactly one attempt; delivered, dead and cancelled are final.
--   queued  -> sending | cancelled
--   sending -> sent | failed | dead
--   sent    -> delivered | failed      (provider delivery receipts)
--   failed  -> sending | dead | cancelled
CREATE OR REPLACE FUNCTION ssos_outbox_state_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'queued' OR NEW.attempts <> 0 THEN
      RAISE EXCEPTION 'outbox_lifecycle: a new outbox row must be queued with 0 attempts (got %, %)', NEW.state, NEW.attempts
        USING ERRCODE = 'check_violation', CONSTRAINT = 'outbox_lifecycle';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.channel IS DISTINCT FROM OLD.channel THEN
    RAISE EXCEPTION 'outbox_lifecycle: tenant and channel of an outbox row are immutable'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'outbox_lifecycle';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
       (OLD.state = 'queued'  AND NEW.state IN ('sending', 'cancelled'))
    OR (OLD.state = 'sending' AND NEW.state IN ('sent', 'failed', 'dead'))
    OR (OLD.state = 'sent'    AND NEW.state IN ('delivered', 'failed'))
    OR (OLD.state = 'failed'  AND NEW.state IN ('sending', 'dead', 'cancelled'))) THEN
    RAISE EXCEPTION 'outbox_lifecycle: illegal transition % -> % for outbox %', OLD.state, NEW.state, OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'outbox_lifecycle';
  END IF;
  IF NEW.state = OLD.state AND OLD.state IN ('delivered', 'dead', 'cancelled') THEN
    RAISE EXCEPTION 'outbox_lifecycle: outbox % is % and can no longer change', OLD.id, OLD.state
      USING ERRCODE = 'check_violation', CONSTRAINT = 'outbox_lifecycle';
  END IF;
  IF NEW.attempts IS DISTINCT FROM OLD.attempts + (CASE WHEN NEW.state = 'sending' AND OLD.state <> 'sending' THEN 1 ELSE 0 END) THEN
    RAISE EXCEPTION 'outbox_lifecycle: attempts only grow by one on each move into sending (outbox %)', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'outbox_lifecycle';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "outbox_state_guard"
  BEFORE INSERT OR UPDATE ON "outbox"
  FOR EACH ROW EXECUTE FUNCTION ssos_outbox_state_guard();
