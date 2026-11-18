CREATE TABLE "TripPlan" (
    "userId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "plan" JSONB NOT NULL,
    CONSTRAINT "TripPlan_pkey" PRIMARY KEY ("userId")
);

ALTER TABLE "TripPlan" ADD CONSTRAINT "TripPlan_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
