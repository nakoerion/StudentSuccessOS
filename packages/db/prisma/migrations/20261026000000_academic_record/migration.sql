-- CreateEnum
CREATE TYPE "attendance_status" AS ENUM ('present', 'absent', 'late', 'excused');

-- CreateEnum
CREATE TYPE "attendance_method" AS ENUM ('grid', 'qr');

-- CreateEnum
CREATE TYPE "ai_policy" AS ENUM ('allowed', 'guided', 'forbidden');

-- CreateEnum
CREATE TYPE "submission_status" AS ENUM ('draft', 'submitted', 'returned', 'resubmitted', 'graded');

-- CreateEnum
CREATE TYPE "note_visibility" AS ENUM ('internal', 'parent', 'student');

-- CreateTable
CREATE TABLE "concept" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "country_pack_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "subject_key" TEXT,
    "grade" TEXT,
    "description" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "concept_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "concept_edge" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "source_concept_id" UUID NOT NULL,
    "target_concept_id" UUID NOT NULL,
    "edge_type" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "concept_edge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "academic_year" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "starts_on" DATE NOT NULL,
    "ends_on" DATE NOT NULL,
    "is_current" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "academic_year_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "term" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "academic_year_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "starts_on" DATE NOT NULL,
    "ends_on" DATE NOT NULL,
    "locked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "term_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subject" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "pack_code" VARCHAR(2),
    "pack_key" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "course" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "academic_year_id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "grade" TEXT,
    "credits" DECIMAL(5,2),
    "grade_scale_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "course_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "class_section" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "course_id" UUID NOT NULL,
    "tenant_unit_id" UUID,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "capacity" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "class_section_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enrollment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "class_section_id" UUID NOT NULL,
    "student_person_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "starts_on" DATE,
    "ends_on" DATE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "enrollment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teacher_assignment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "teacher_person_id" UUID NOT NULL,
    "course_id" UUID NOT NULL,
    "class_section_id" UUID,
    "role" TEXT NOT NULL DEFAULT 'primary',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "teacher_assignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "timetable_slot" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "class_section_id" UUID NOT NULL,
    "teacher_assignment_id" UUID,
    "term_id" UUID,
    "room" TEXT,
    "day_of_week" SMALLINT NOT NULL,
    "starts_at" TIME(0) NOT NULL,
    "ends_at" TIME(0) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "timetable_slot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_event" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "enrollment_id" UUID NOT NULL,
    "student_person_id" UUID NOT NULL,
    "timetable_slot_id" UUID,
    "date" DATE NOT NULL,
    "status" "attendance_status" NOT NULL,
    "method" "attendance_method" NOT NULL DEFAULT 'grid',
    "recorded_by_person_id" UUID,
    "comment" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assessment_category" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "course_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "weight" DECIMAL(5,2) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assessment_category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "grade_entry" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "enrollment_id" UUID NOT NULL,
    "assessment_category_id" UUID NOT NULL,
    "term_id" UUID NOT NULL,
    "assignment_id" UUID,
    "grade_scale_id" UUID NOT NULL,
    "raw_mark" DECIMAL(6,2) NOT NULL,
    "graded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "graded_by_person_id" UUID,
    "comment" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "grade_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "term_grade" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "enrollment_id" UUID NOT NULL,
    "term_id" UUID NOT NULL,
    "grade_scale_id" UUID NOT NULL,
    "value" DECIMAL(6,2) NOT NULL,
    "percentage" DECIMAL(5,2),
    "inputs" JSONB,
    "computed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "term_grade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "annual_grade" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "enrollment_id" UUID NOT NULL,
    "academic_year_id" UUID NOT NULL,
    "grade_scale_id" UUID NOT NULL,
    "value" DECIMAL(6,2) NOT NULL,
    "percentage" DECIMAL(5,2),
    "inputs" JSONB,
    "computed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "annual_grade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assignment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "class_section_id" UUID NOT NULL,
    "assessment_category_id" UUID,
    "created_by_person_id" UUID,
    "title" TEXT NOT NULL,
    "instructions" TEXT,
    "rubric" JSONB,
    "max_points" DECIMAL(6,2),
    "due_at" TIMESTAMPTZ(6),
    "late_policy" JSONB,
    "ai_policy" "ai_policy" NOT NULL DEFAULT 'guided',
    "published_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "submission" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "assignment_id" UUID NOT NULL,
    "student_person_id" UUID NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "status" "submission_status" NOT NULL DEFAULT 'draft',
    "text_body" TEXT,
    "file_refs" JSONB NOT NULL DEFAULT '[]',
    "photo_refs" JSONB NOT NULL DEFAULT '[]',
    "submitted_at" TIMESTAMPTZ(6),
    "is_late" BOOLEAN NOT NULL DEFAULT false,
    "plagiarism_flag" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "submission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rubric_score" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "submission_id" UUID NOT NULL,
    "criterion_key" TEXT NOT NULL,
    "score" DECIMAL(6,2) NOT NULL,
    "comment" TEXT,
    "scored_by_person_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rubric_score_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "note" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "subject_person_id" UUID NOT NULL,
    "author_person_id" UUID,
    "visibility" "note_visibility" NOT NULL DEFAULT 'internal',
    "body" TEXT NOT NULL,
    "entity_type" TEXT,
    "entity_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "note_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_person_id" UUID,
    "actor_user_id" UUID,
    "subject_person_id" UUID,
    "type" TEXT NOT NULL,
    "entity_type" TEXT,
    "entity_id" UUID,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "evidence_refs" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "edge" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_id" UUID NOT NULL,
    "edge_type" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" UUID NOT NULL,
    "data" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "edge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mastery_state" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "student_person_id" UUID NOT NULL,
    "concept_id" UUID NOT NULL,
    "level" DECIMAL(4,3),
    "evidence_count" INTEGER NOT NULL DEFAULT 0,
    "last_evidence_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mastery_state_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "concept_country_pack_id_subject_key_idx" ON "concept"("country_pack_id", "subject_key");

-- CreateIndex
CREATE UNIQUE INDEX "concept_country_pack_id_code_key" ON "concept"("country_pack_id", "code");

-- CreateIndex
CREATE INDEX "concept_edge_target_concept_id_idx" ON "concept_edge"("target_concept_id");

-- CreateIndex
CREATE UNIQUE INDEX "concept_edge_source_concept_id_target_concept_id_edge_type_key" ON "concept_edge"("source_concept_id", "target_concept_id", "edge_type");

-- CreateIndex
CREATE INDEX "academic_year_tenant_id_idx" ON "academic_year"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "academic_year_tenant_id_id_key" ON "academic_year"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "academic_year_tenant_id_name_key" ON "academic_year"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "term_tenant_id_idx" ON "term"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "term_tenant_id_id_key" ON "term"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "term_tenant_id_academic_year_id_key_key" ON "term"("tenant_id", "academic_year_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "term_tenant_id_academic_year_id_sequence_key" ON "term"("tenant_id", "academic_year_id", "sequence");

-- CreateIndex
CREATE INDEX "subject_tenant_id_idx" ON "subject"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "subject_tenant_id_id_key" ON "subject"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "subject_tenant_id_code_key" ON "subject"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "course_tenant_id_idx" ON "course"("tenant_id");

-- CreateIndex
CREATE INDEX "course_tenant_id_subject_id_idx" ON "course"("tenant_id", "subject_id");

-- CreateIndex
CREATE UNIQUE INDEX "course_tenant_id_id_key" ON "course"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "course_tenant_id_academic_year_id_code_key" ON "course"("tenant_id", "academic_year_id", "code");

-- CreateIndex
CREATE INDEX "class_section_tenant_id_idx" ON "class_section"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "class_section_tenant_id_id_key" ON "class_section"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "class_section_tenant_id_course_id_code_key" ON "class_section"("tenant_id", "course_id", "code");

-- CreateIndex
CREATE INDEX "enrollment_tenant_id_idx" ON "enrollment"("tenant_id");

-- CreateIndex
CREATE INDEX "enrollment_tenant_id_student_person_id_idx" ON "enrollment"("tenant_id", "student_person_id");

-- CreateIndex
CREATE UNIQUE INDEX "enrollment_tenant_id_id_key" ON "enrollment"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "enrollment_tenant_id_class_section_id_student_person_id_key" ON "enrollment"("tenant_id", "class_section_id", "student_person_id");

-- CreateIndex
CREATE INDEX "teacher_assignment_tenant_id_idx" ON "teacher_assignment"("tenant_id");

-- CreateIndex
CREATE INDEX "teacher_assignment_tenant_id_course_id_idx" ON "teacher_assignment"("tenant_id", "course_id");

-- CreateIndex
CREATE UNIQUE INDEX "teacher_assignment_tenant_id_id_key" ON "teacher_assignment"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "teacher_assignment_tenant_id_teacher_person_id_course_id_cl_key" ON "teacher_assignment"("tenant_id", "teacher_person_id", "course_id", "class_section_id");

-- CreateIndex
CREATE INDEX "timetable_slot_tenant_id_idx" ON "timetable_slot"("tenant_id");

-- CreateIndex
CREATE INDEX "timetable_slot_tenant_id_class_section_id_idx" ON "timetable_slot"("tenant_id", "class_section_id");

-- CreateIndex
CREATE INDEX "timetable_slot_tenant_id_day_of_week_idx" ON "timetable_slot"("tenant_id", "day_of_week");

-- CreateIndex
CREATE UNIQUE INDEX "timetable_slot_tenant_id_id_key" ON "timetable_slot"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "attendance_event_tenant_id_idx" ON "attendance_event"("tenant_id");

-- CreateIndex
CREATE INDEX "attendance_event_tenant_id_student_person_id_date_idx" ON "attendance_event"("tenant_id", "student_person_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_event_tenant_id_enrollment_id_date_timetable_slo_key" ON "attendance_event"("tenant_id", "enrollment_id", "date", "timetable_slot_id");

-- CreateIndex
CREATE INDEX "assessment_category_tenant_id_idx" ON "assessment_category"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "assessment_category_tenant_id_id_key" ON "assessment_category"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "assessment_category_tenant_id_course_id_name_key" ON "assessment_category"("tenant_id", "course_id", "name");

-- CreateIndex
CREATE INDEX "grade_entry_tenant_id_idx" ON "grade_entry"("tenant_id");

-- CreateIndex
CREATE INDEX "grade_entry_tenant_id_enrollment_id_term_id_idx" ON "grade_entry"("tenant_id", "enrollment_id", "term_id");

-- CreateIndex
CREATE INDEX "term_grade_tenant_id_idx" ON "term_grade"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "term_grade_tenant_id_enrollment_id_term_id_key" ON "term_grade"("tenant_id", "enrollment_id", "term_id");

-- CreateIndex
CREATE INDEX "annual_grade_tenant_id_idx" ON "annual_grade"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "annual_grade_tenant_id_enrollment_id_academic_year_id_key" ON "annual_grade"("tenant_id", "enrollment_id", "academic_year_id");

-- CreateIndex
CREATE INDEX "assignment_tenant_id_idx" ON "assignment"("tenant_id");

-- CreateIndex
CREATE INDEX "assignment_tenant_id_class_section_id_idx" ON "assignment"("tenant_id", "class_section_id");

-- CreateIndex
CREATE UNIQUE INDEX "assignment_tenant_id_id_key" ON "assignment"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "submission_tenant_id_idx" ON "submission"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "submission_tenant_id_id_key" ON "submission"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "submission_tenant_id_assignment_id_student_person_id_attemp_key" ON "submission"("tenant_id", "assignment_id", "student_person_id", "attempt");

-- CreateIndex
CREATE INDEX "rubric_score_tenant_id_idx" ON "rubric_score"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "rubric_score_tenant_id_submission_id_criterion_key_key" ON "rubric_score"("tenant_id", "submission_id", "criterion_key");

-- CreateIndex
CREATE INDEX "note_tenant_id_idx" ON "note"("tenant_id");

-- CreateIndex
CREATE INDEX "note_tenant_id_subject_person_id_idx" ON "note"("tenant_id", "subject_person_id");

-- CreateIndex
CREATE INDEX "event_tenant_id_idx" ON "event"("tenant_id");

-- CreateIndex
CREATE INDEX "event_tenant_id_subject_person_id_occurred_at_idx" ON "event"("tenant_id", "subject_person_id", "occurred_at");

-- CreateIndex
CREATE INDEX "event_tenant_id_entity_type_entity_id_idx" ON "event"("tenant_id", "entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "edge_tenant_id_idx" ON "edge"("tenant_id");

-- CreateIndex
CREATE INDEX "edge_tenant_id_target_type_target_id_idx" ON "edge"("tenant_id", "target_type", "target_id");

-- CreateIndex
CREATE UNIQUE INDEX "edge_tenant_id_source_type_source_id_edge_type_target_type__key" ON "edge"("tenant_id", "source_type", "source_id", "edge_type", "target_type", "target_id");

-- CreateIndex
CREATE INDEX "mastery_state_tenant_id_idx" ON "mastery_state"("tenant_id");

-- CreateIndex
CREATE INDEX "mastery_state_concept_id_idx" ON "mastery_state"("concept_id");

-- CreateIndex
CREATE UNIQUE INDEX "mastery_state_tenant_id_student_person_id_concept_id_key" ON "mastery_state"("tenant_id", "student_person_id", "concept_id");

-- AddForeignKey
ALTER TABLE "concept" ADD CONSTRAINT "concept_country_pack_id_fkey" FOREIGN KEY ("country_pack_id") REFERENCES "country_pack"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "concept_edge" ADD CONSTRAINT "concept_edge_source_concept_id_fkey" FOREIGN KEY ("source_concept_id") REFERENCES "concept"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "concept_edge" ADD CONSTRAINT "concept_edge_target_concept_id_fkey" FOREIGN KEY ("target_concept_id") REFERENCES "concept"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "academic_year" ADD CONSTRAINT "academic_year_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "term" ADD CONSTRAINT "term_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "term" ADD CONSTRAINT "term_tenant_id_academic_year_id_fkey" FOREIGN KEY ("tenant_id", "academic_year_id") REFERENCES "academic_year"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subject" ADD CONSTRAINT "subject_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course" ADD CONSTRAINT "course_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course" ADD CONSTRAINT "course_tenant_id_academic_year_id_fkey" FOREIGN KEY ("tenant_id", "academic_year_id") REFERENCES "academic_year"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course" ADD CONSTRAINT "course_tenant_id_subject_id_fkey" FOREIGN KEY ("tenant_id", "subject_id") REFERENCES "subject"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course" ADD CONSTRAINT "course_grade_scale_id_fkey" FOREIGN KEY ("grade_scale_id") REFERENCES "grade_scale"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "class_section" ADD CONSTRAINT "class_section_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "class_section" ADD CONSTRAINT "class_section_tenant_id_course_id_fkey" FOREIGN KEY ("tenant_id", "course_id") REFERENCES "course"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "class_section" ADD CONSTRAINT "class_section_tenant_id_tenant_unit_id_fkey" FOREIGN KEY ("tenant_id", "tenant_unit_id") REFERENCES "tenant_unit"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollment" ADD CONSTRAINT "enrollment_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollment" ADD CONSTRAINT "enrollment_tenant_id_class_section_id_fkey" FOREIGN KEY ("tenant_id", "class_section_id") REFERENCES "class_section"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollment" ADD CONSTRAINT "enrollment_tenant_id_student_person_id_fkey" FOREIGN KEY ("tenant_id", "student_person_id") REFERENCES "person"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teacher_assignment" ADD CONSTRAINT "teacher_assignment_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teacher_assignment" ADD CONSTRAINT "teacher_assignment_tenant_id_teacher_person_id_fkey" FOREIGN KEY ("tenant_id", "teacher_person_id") REFERENCES "person"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teacher_assignment" ADD CONSTRAINT "teacher_assignment_tenant_id_course_id_fkey" FOREIGN KEY ("tenant_id", "course_id") REFERENCES "course"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teacher_assignment" ADD CONSTRAINT "teacher_assignment_tenant_id_class_section_id_fkey" FOREIGN KEY ("tenant_id", "class_section_id") REFERENCES "class_section"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timetable_slot" ADD CONSTRAINT "timetable_slot_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timetable_slot" ADD CONSTRAINT "timetable_slot_tenant_id_class_section_id_fkey" FOREIGN KEY ("tenant_id", "class_section_id") REFERENCES "class_section"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timetable_slot" ADD CONSTRAINT "timetable_slot_tenant_id_teacher_assignment_id_fkey" FOREIGN KEY ("tenant_id", "teacher_assignment_id") REFERENCES "teacher_assignment"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timetable_slot" ADD CONSTRAINT "timetable_slot_tenant_id_term_id_fkey" FOREIGN KEY ("tenant_id", "term_id") REFERENCES "term"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_event" ADD CONSTRAINT "attendance_event_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_event" ADD CONSTRAINT "attendance_event_tenant_id_enrollment_id_fkey" FOREIGN KEY ("tenant_id", "enrollment_id") REFERENCES "enrollment"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_event" ADD CONSTRAINT "attendance_event_tenant_id_student_person_id_fkey" FOREIGN KEY ("tenant_id", "student_person_id") REFERENCES "person"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_event" ADD CONSTRAINT "attendance_event_tenant_id_timetable_slot_id_fkey" FOREIGN KEY ("tenant_id", "timetable_slot_id") REFERENCES "timetable_slot"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_event" ADD CONSTRAINT "attendance_event_tenant_id_recorded_by_person_id_fkey" FOREIGN KEY ("tenant_id", "recorded_by_person_id") REFERENCES "person"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment_category" ADD CONSTRAINT "assessment_category_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assessment_category" ADD CONSTRAINT "assessment_category_tenant_id_course_id_fkey" FOREIGN KEY ("tenant_id", "course_id") REFERENCES "course"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grade_entry" ADD CONSTRAINT "grade_entry_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grade_entry" ADD CONSTRAINT "grade_entry_tenant_id_enrollment_id_fkey" FOREIGN KEY ("tenant_id", "enrollment_id") REFERENCES "enrollment"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grade_entry" ADD CONSTRAINT "grade_entry_tenant_id_assessment_category_id_fkey" FOREIGN KEY ("tenant_id", "assessment_category_id") REFERENCES "assessment_category"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grade_entry" ADD CONSTRAINT "grade_entry_tenant_id_term_id_fkey" FOREIGN KEY ("tenant_id", "term_id") REFERENCES "term"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grade_entry" ADD CONSTRAINT "grade_entry_tenant_id_assignment_id_fkey" FOREIGN KEY ("tenant_id", "assignment_id") REFERENCES "assignment"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grade_entry" ADD CONSTRAINT "grade_entry_grade_scale_id_fkey" FOREIGN KEY ("grade_scale_id") REFERENCES "grade_scale"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grade_entry" ADD CONSTRAINT "grade_entry_tenant_id_graded_by_person_id_fkey" FOREIGN KEY ("tenant_id", "graded_by_person_id") REFERENCES "person"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "term_grade" ADD CONSTRAINT "term_grade_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "term_grade" ADD CONSTRAINT "term_grade_tenant_id_enrollment_id_fkey" FOREIGN KEY ("tenant_id", "enrollment_id") REFERENCES "enrollment"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "term_grade" ADD CONSTRAINT "term_grade_tenant_id_term_id_fkey" FOREIGN KEY ("tenant_id", "term_id") REFERENCES "term"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "term_grade" ADD CONSTRAINT "term_grade_grade_scale_id_fkey" FOREIGN KEY ("grade_scale_id") REFERENCES "grade_scale"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "annual_grade" ADD CONSTRAINT "annual_grade_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "annual_grade" ADD CONSTRAINT "annual_grade_tenant_id_enrollment_id_fkey" FOREIGN KEY ("tenant_id", "enrollment_id") REFERENCES "enrollment"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "annual_grade" ADD CONSTRAINT "annual_grade_tenant_id_academic_year_id_fkey" FOREIGN KEY ("tenant_id", "academic_year_id") REFERENCES "academic_year"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "annual_grade" ADD CONSTRAINT "annual_grade_grade_scale_id_fkey" FOREIGN KEY ("grade_scale_id") REFERENCES "grade_scale"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignment" ADD CONSTRAINT "assignment_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignment" ADD CONSTRAINT "assignment_tenant_id_class_section_id_fkey" FOREIGN KEY ("tenant_id", "class_section_id") REFERENCES "class_section"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignment" ADD CONSTRAINT "assignment_tenant_id_assessment_category_id_fkey" FOREIGN KEY ("tenant_id", "assessment_category_id") REFERENCES "assessment_category"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignment" ADD CONSTRAINT "assignment_tenant_id_created_by_person_id_fkey" FOREIGN KEY ("tenant_id", "created_by_person_id") REFERENCES "person"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submission" ADD CONSTRAINT "submission_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submission" ADD CONSTRAINT "submission_tenant_id_assignment_id_fkey" FOREIGN KEY ("tenant_id", "assignment_id") REFERENCES "assignment"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "submission" ADD CONSTRAINT "submission_tenant_id_student_person_id_fkey" FOREIGN KEY ("tenant_id", "student_person_id") REFERENCES "person"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rubric_score" ADD CONSTRAINT "rubric_score_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rubric_score" ADD CONSTRAINT "rubric_score_tenant_id_submission_id_fkey" FOREIGN KEY ("tenant_id", "submission_id") REFERENCES "submission"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rubric_score" ADD CONSTRAINT "rubric_score_tenant_id_scored_by_person_id_fkey" FOREIGN KEY ("tenant_id", "scored_by_person_id") REFERENCES "person"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "note" ADD CONSTRAINT "note_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "note" ADD CONSTRAINT "note_tenant_id_subject_person_id_fkey" FOREIGN KEY ("tenant_id", "subject_person_id") REFERENCES "person"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "note" ADD CONSTRAINT "note_tenant_id_author_person_id_fkey" FOREIGN KEY ("tenant_id", "author_person_id") REFERENCES "person"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event" ADD CONSTRAINT "event_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event" ADD CONSTRAINT "event_tenant_id_actor_person_id_fkey" FOREIGN KEY ("tenant_id", "actor_person_id") REFERENCES "person"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event" ADD CONSTRAINT "event_tenant_id_subject_person_id_fkey" FOREIGN KEY ("tenant_id", "subject_person_id") REFERENCES "person"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "edge" ADD CONSTRAINT "edge_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mastery_state" ADD CONSTRAINT "mastery_state_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mastery_state" ADD CONSTRAINT "mastery_state_tenant_id_student_person_id_fkey" FOREIGN KEY ("tenant_id", "student_person_id") REFERENCES "person"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mastery_state" ADD CONSTRAINT "mastery_state_concept_id_fkey" FOREIGN KEY ("concept_id") REFERENCES "concept"("id") ON DELETE NO ACTION ON UPDATE CASCADE;


-- ─── Hand-written integrity rules Prisma's schema language cannot express ────
-- (RLS policies and grants for these tables come from the generated
-- 20261026000100_rls migration, never from here.)

-- Nullable columns in a uniqueness key: treat NULL as a value (Postgres 15+), so
-- "teaches every section" and "whole-day attendance" can only be recorded once.
DROP INDEX IF EXISTS "teacher_assignment_tenant_id_teacher_person_id_course_id_cl_key";
CREATE UNIQUE INDEX "teacher_assignment_tenant_id_teacher_person_id_course_id_cl_key"
  ON "teacher_assignment" ("tenant_id", "teacher_person_id", "course_id", "class_section_id") NULLS NOT DISTINCT;
DROP INDEX IF EXISTS "attendance_event_tenant_id_enrollment_id_date_timetable_slo_key";
CREATE UNIQUE INDEX "attendance_event_tenant_id_enrollment_id_date_timetable_slo_key"
  ON "attendance_event" ("tenant_id", "enrollment_id", "date", "timetable_slot_id") NULLS NOT DISTINCT;

-- Value checks.
ALTER TABLE "academic_year" ADD CONSTRAINT "academic_year_dates_check" CHECK ("starts_on" < "ends_on");
ALTER TABLE "term" ADD CONSTRAINT "term_dates_check" CHECK ("starts_on" <= "ends_on");
ALTER TABLE "term" ADD CONSTRAINT "term_sequence_check" CHECK ("sequence" >= 1);
ALTER TABLE "timetable_slot" ADD CONSTRAINT "timetable_slot_day_check" CHECK ("day_of_week" BETWEEN 1 AND 7);
ALTER TABLE "timetable_slot" ADD CONSTRAINT "timetable_slot_time_check" CHECK ("starts_at" < "ends_at");
ALTER TABLE "assessment_category" ADD CONSTRAINT "assessment_category_weight_check" CHECK ("weight" >= 0 AND "weight" <= 100);
ALTER TABLE "submission" ADD CONSTRAINT "submission_attempt_check" CHECK ("attempt" >= 1);
ALTER TABLE "mastery_state" ADD CONSTRAINT "mastery_state_level_check" CHECK ("level" IS NULL OR ("level" >= 0 AND "level" <= 1));
ALTER TABLE "concept_edge" ADD CONSTRAINT "concept_edge_no_self_loop" CHECK ("source_concept_id" <> "target_concept_id");
ALTER TABLE "edge" ADD CONSTRAINT "edge_no_self_loop"
  CHECK (NOT ("source_type" = "target_type" AND "source_id" = "target_id"));

-- grade_scale is a shared table (tenant_id NULL = pack default, else a tenant
-- override), so a plain FK cannot stop a tenant row pointing at another tenant's
-- override. Same approach as ssos_check_role_tenant: the lookup runs as the
-- calling role, so under RLS another tenant's scale is simply not found.
CREATE OR REPLACE FUNCTION ssos_check_grade_scale_tenant() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  scale_tenant uuid;
BEGIN
  IF NEW.grade_scale_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT g.tenant_id INTO scale_tenant FROM "grade_scale" g WHERE g.id = NEW.grade_scale_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'grade_scale % not visible to tenant %', NEW.grade_scale_id, NEW.tenant_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF scale_tenant IS NOT NULL AND scale_tenant <> NEW.tenant_id THEN
    RAISE EXCEPTION 'grade_scale % belongs to another tenant', NEW.grade_scale_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER course_grade_scale_tenant
  BEFORE INSERT OR UPDATE OF grade_scale_id, tenant_id ON "course"
  FOR EACH ROW EXECUTE FUNCTION ssos_check_grade_scale_tenant();
CREATE TRIGGER grade_entry_grade_scale_tenant
  BEFORE INSERT OR UPDATE OF grade_scale_id, tenant_id ON "grade_entry"
  FOR EACH ROW EXECUTE FUNCTION ssos_check_grade_scale_tenant();
CREATE TRIGGER term_grade_grade_scale_tenant
  BEFORE INSERT OR UPDATE OF grade_scale_id, tenant_id ON "term_grade"
  FOR EACH ROW EXECUTE FUNCTION ssos_check_grade_scale_tenant();
CREATE TRIGGER annual_grade_grade_scale_tenant
  BEFORE INSERT OR UPDATE OF grade_scale_id, tenant_id ON "annual_grade"
  FOR EACH ROW EXECUTE FUNCTION ssos_check_grade_scale_tenant();
