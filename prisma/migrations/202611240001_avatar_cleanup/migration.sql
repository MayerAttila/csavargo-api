CREATE TABLE "AvatarCleanup" (
    "key" TEXT NOT NULL,
    "availableAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AvatarCleanup_pkey" PRIMARY KEY ("key")
);

CREATE INDEX "AvatarCleanup_availableAt_idx" ON "AvatarCleanup"("availableAt");
