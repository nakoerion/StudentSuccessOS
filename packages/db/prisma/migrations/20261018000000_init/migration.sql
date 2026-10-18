-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "country_pack" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" VARCHAR(2) NOT NULL,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "country_pack_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "country_pack_id" UUID NOT NULL,
    "default_locale" VARCHAR(8) NOT NULL,
    "timezone" TEXT NOT NULL,
    "join_code" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permission" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "key" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "permission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_account" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" TEXT NOT NULL,
    "external_auth_id" TEXT,
    "display_name" TEXT,
    "locale" VARCHAR(8),
    "last_sign_in_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "grade_scale" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID,
    "country_pack_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "min_value" DECIMAL(6,2) NOT NULL,
    "max_value" DECIMAL(6,2) NOT NULL,
    "pass_mark" DECIMAL(6,2) NOT NULL,
    "bands" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "grade_scale_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permission" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID,
    "role_id" UUID NOT NULL,
    "permission_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_permission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_unit" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "parent_id" UUID,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "grade_level" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_unit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_setting" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_setting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "person" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "user_account_id" UUID,
    "given_name" TEXT NOT NULL,
    "family_name" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "date_of_birth" DATE,
    "locale" VARCHAR(8),
    "external_ref" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "person_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_assignment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "person_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "tenant_unit_id" UUID,
    "starts_at" TIMESTAMPTZ(6),
    "ends_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_assignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guardianship" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "guardian_person_id" UUID NOT NULL,
    "student_person_id" UUID NOT NULL,
    "relationship" TEXT NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guardianship_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consent" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "subject_person_id" UUID NOT NULL,
    "granted_by_person_id" UUID,
    "purpose" TEXT NOT NULL,
    "granted_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitation" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "code" TEXT,
    "email" TEXT,
    "role_id" UUID NOT NULL,
    "tenant_unit_id" UUID,
    "person_id" UUID,
    "invited_by_person_id" UUID,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "accepted_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roster_import" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "file_name" TEXT,
    "report" JSONB,
    "started_by_person_id" UUID,
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "roster_import_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "actor_person_id" UUID,
    "actor_user_id" UUID,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID,
    "data" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "country_pack_code_key" ON "country_pack"("code");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_slug_key" ON "tenant"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_join_code_key" ON "tenant"("join_code");

-- CreateIndex
CREATE INDEX "tenant_country_pack_id_idx" ON "tenant"("country_pack_id");

-- CreateIndex
CREATE UNIQUE INDEX "permission_key_key" ON "permission"("key");

-- CreateIndex
CREATE UNIQUE INDEX "user_account_email_key" ON "user_account"("email");

-- CreateIndex
CREATE UNIQUE INDEX "user_account_external_auth_id_key" ON "user_account"("external_auth_id");

-- CreateIndex
CREATE INDEX "grade_scale_tenant_id_idx" ON "grade_scale"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "grade_scale_country_pack_id_tenant_id_key_key" ON "grade_scale"("country_pack_id", "tenant_id", "key");

-- CreateIndex
CREATE INDEX "role_tenant_id_idx" ON "role"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "role_tenant_id_key_key" ON "role"("tenant_id", "key");

-- CreateIndex
CREATE INDEX "role_permission_tenant_id_idx" ON "role_permission"("tenant_id");

-- CreateIndex
CREATE INDEX "role_permission_permission_id_idx" ON "role_permission"("permission_id");

-- CreateIndex
CREATE UNIQUE INDEX "role_permission_role_id_permission_id_key" ON "role_permission"("role_id", "permission_id");

-- CreateIndex
CREATE INDEX "tenant_unit_tenant_id_idx" ON "tenant_unit"("tenant_id");

-- CreateIndex
CREATE INDEX "tenant_unit_tenant_id_parent_id_idx" ON "tenant_unit"("tenant_id", "parent_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_unit_tenant_id_id_key" ON "tenant_unit"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_unit_tenant_id_code_key" ON "tenant_unit"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "tenant_setting_tenant_id_idx" ON "tenant_setting"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_setting_tenant_id_key_key" ON "tenant_setting"("tenant_id", "key");

-- CreateIndex
CREATE INDEX "person_tenant_id_idx" ON "person"("tenant_id");

-- CreateIndex
CREATE INDEX "person_user_account_id_idx" ON "person"("user_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "person_tenant_id_id_key" ON "person"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "person_tenant_id_user_account_id_key" ON "person"("tenant_id", "user_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "person_tenant_id_external_ref_key" ON "person"("tenant_id", "external_ref");

-- CreateIndex
CREATE INDEX "role_assignment_tenant_id_idx" ON "role_assignment"("tenant_id");

-- CreateIndex
CREATE INDEX "role_assignment_tenant_id_person_id_idx" ON "role_assignment"("tenant_id", "person_id");

-- CreateIndex
CREATE INDEX "role_assignment_role_id_idx" ON "role_assignment"("role_id");

-- CreateIndex
CREATE INDEX "role_assignment_tenant_id_tenant_unit_id_idx" ON "role_assignment"("tenant_id", "tenant_unit_id");

-- CreateIndex
CREATE INDEX "guardianship_tenant_id_idx" ON "guardianship"("tenant_id");

-- CreateIndex
CREATE INDEX "guardianship_tenant_id_student_person_id_idx" ON "guardianship"("tenant_id", "student_person_id");

-- CreateIndex
CREATE UNIQUE INDEX "guardianship_tenant_id_guardian_person_id_student_person_id_key" ON "guardianship"("tenant_id", "guardian_person_id", "student_person_id");

-- CreateIndex
CREATE INDEX "consent_tenant_id_idx" ON "consent"("tenant_id");

-- CreateIndex
CREATE INDEX "consent_tenant_id_subject_person_id_idx" ON "consent"("tenant_id", "subject_person_id");

-- CreateIndex
CREATE UNIQUE INDEX "invitation_token_key" ON "invitation"("token");

-- CreateIndex
CREATE UNIQUE INDEX "invitation_code_key" ON "invitation"("code");

-- CreateIndex
CREATE INDEX "invitation_tenant_id_idx" ON "invitation"("tenant_id");

-- CreateIndex
CREATE INDEX "invitation_role_id_idx" ON "invitation"("role_id");

-- CreateIndex
CREATE INDEX "roster_import_tenant_id_idx" ON "roster_import"("tenant_id");

-- CreateIndex
CREATE INDEX "audit_log_tenant_id_idx" ON "audit_log"("tenant_id");

-- CreateIndex
CREATE INDEX "audit_log_tenant_id_entity_type_entity_id_idx" ON "audit_log"("tenant_id", "entity_type", "entity_id");

-- AddForeignKey
ALTER TABLE "tenant" ADD CONSTRAINT "tenant_country_pack_id_fkey" FOREIGN KEY ("country_pack_id") REFERENCES "country_pack"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grade_scale" ADD CONSTRAINT "grade_scale_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grade_scale" ADD CONSTRAINT "grade_scale_country_pack_id_fkey" FOREIGN KEY ("country_pack_id") REFERENCES "country_pack"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role" ADD CONSTRAINT "role_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_unit" ADD CONSTRAINT "tenant_unit_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_unit" ADD CONSTRAINT "tenant_unit_tenant_id_parent_id_fkey" FOREIGN KEY ("tenant_id", "parent_id") REFERENCES "tenant_unit"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_setting" ADD CONSTRAINT "tenant_setting_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "person" ADD CONSTRAINT "person_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "person" ADD CONSTRAINT "person_user_account_id_fkey" FOREIGN KEY ("user_account_id") REFERENCES "user_account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_assignment" ADD CONSTRAINT "role_assignment_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_assignment" ADD CONSTRAINT "role_assignment_tenant_id_person_id_fkey" FOREIGN KEY ("tenant_id", "person_id") REFERENCES "person"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_assignment" ADD CONSTRAINT "role_assignment_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_assignment" ADD CONSTRAINT "role_assignment_tenant_id_tenant_unit_id_fkey" FOREIGN KEY ("tenant_id", "tenant_unit_id") REFERENCES "tenant_unit"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guardianship" ADD CONSTRAINT "guardianship_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guardianship" ADD CONSTRAINT "guardianship_tenant_id_guardian_person_id_fkey" FOREIGN KEY ("tenant_id", "guardian_person_id") REFERENCES "person"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guardianship" ADD CONSTRAINT "guardianship_tenant_id_student_person_id_fkey" FOREIGN KEY ("tenant_id", "student_person_id") REFERENCES "person"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent" ADD CONSTRAINT "consent_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent" ADD CONSTRAINT "consent_tenant_id_subject_person_id_fkey" FOREIGN KEY ("tenant_id", "subject_person_id") REFERENCES "person"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent" ADD CONSTRAINT "consent_tenant_id_granted_by_person_id_fkey" FOREIGN KEY ("tenant_id", "granted_by_person_id") REFERENCES "person"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_tenant_id_tenant_unit_id_fkey" FOREIGN KEY ("tenant_id", "tenant_unit_id") REFERENCES "tenant_unit"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_tenant_id_person_id_fkey" FOREIGN KEY ("tenant_id", "person_id") REFERENCES "person"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_tenant_id_invited_by_person_id_fkey" FOREIGN KEY ("tenant_id", "invited_by_person_id") REFERENCES "person"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roster_import" ADD CONSTRAINT "roster_import_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roster_import" ADD CONSTRAINT "roster_import_tenant_id_started_by_person_id_fkey" FOREIGN KEY ("tenant_id", "started_by_person_id") REFERENCES "person"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_tenant_id_actor_person_id_fkey" FOREIGN KEY ("tenant_id", "actor_person_id") REFERENCES "person"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

