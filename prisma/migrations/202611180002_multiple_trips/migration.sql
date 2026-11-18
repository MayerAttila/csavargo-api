ALTER TABLE "TripPlan" ADD COLUMN "id" TEXT,
    ADD COLUMN "slug" TEXT,
    ADD COLUMN "name" TEXT;

UPDATE "TripPlan"
SET "id" = 'legacy',
    "name" = "plan" #>> '{destination,label}',
    "slug" = COALESCE(NULLIF(TRIM(BOTH '-' FROM LEFT(
        regexp_replace(translate(lower("plan" #>> '{destination,label}'), 'áéíóöőúüű', 'aeiooouuu'), '[^a-z0-9]+', '-', 'g'), 64
    )), ''), 'utazas') || '-' || LEFT("plan" ->> 'start', 7);

ALTER TABLE "TripPlan" ALTER COLUMN "id" SET NOT NULL,
    ALTER COLUMN "slug" SET NOT NULL,
    ALTER COLUMN "name" SET NOT NULL,
    DROP CONSTRAINT "TripPlan_pkey",
    ADD CONSTRAINT "TripPlan_pkey" PRIMARY KEY ("userId", "id");

CREATE UNIQUE INDEX "TripPlan_userId_slug_key" ON "TripPlan"("userId", "slug");
