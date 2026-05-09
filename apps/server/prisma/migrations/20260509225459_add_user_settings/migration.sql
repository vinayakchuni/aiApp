-- AlterTable
ALTER TABLE "User" ADD COLUMN "preferredModel" TEXT NOT NULL DEFAULT 'openai:gpt-4o-mini',
                   ADD COLUMN "streamingEnabled" BOOLEAN NOT NULL DEFAULT true;
