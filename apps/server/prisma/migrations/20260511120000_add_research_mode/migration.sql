-- CreateEnum
CREATE TYPE "ConversationMode" AS ENUM ('chat', 'research');

-- CreateEnum
CREATE TYPE "ResearchStatus" AS ENUM ('idle', 'clarifying', 'researching', 'drafting', 'critiquing', 'fact_checking', 'finalizing', 'complete', 'failed');

-- AlterTable
ALTER TABLE "Conversation"
    ADD COLUMN "mode" "ConversationMode" NOT NULL DEFAULT 'chat',
    ADD COLUMN "researchStatus" "ResearchStatus" NOT NULL DEFAULT 'idle';

-- AlterTable
ALTER TABLE "Message" ADD COLUMN "metadata" JSONB;
