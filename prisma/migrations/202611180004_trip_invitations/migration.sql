CREATE TABLE "TripInvitation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "tripId" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    CONSTRAINT "TripInvitation_not_owner" CHECK ("ownerId" <> "recipientId"),
    CONSTRAINT "TripInvitation_ownerId_tripId_fkey" FOREIGN KEY ("ownerId", "tripId") REFERENCES "TripPlan"("userId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TripInvitation_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "TripInvitation_ownerId_tripId_recipientId_key" ON "TripInvitation"("ownerId", "tripId", "recipientId");
CREATE INDEX "TripInvitation_recipientId_idx" ON "TripInvitation"("recipientId");
