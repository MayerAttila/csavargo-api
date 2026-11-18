CREATE TABLE "Companion" (
    "id" TEXT NOT NULL,
    "firstId" TEXT NOT NULL,
    "secondId" TEXT NOT NULL,
    "requesterId" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    CONSTRAINT "Companion_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Companion_pair_check" CHECK ("firstId" COLLATE "C" < "secondId" COLLATE "C"),
    CONSTRAINT "Companion_requester_check" CHECK ("requesterId" IN ("firstId", "secondId")),
    CONSTRAINT "Companion_firstId_fkey" FOREIGN KEY ("firstId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Companion_secondId_fkey" FOREIGN KEY ("secondId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "Companion_firstId_secondId_key" ON "Companion"("firstId", "secondId");
CREATE INDEX "Companion_secondId_idx" ON "Companion"("secondId");
