-- CreateEnum
CREATE TYPE "PipelineStage" AS ENUM ('SEARCHING', 'CRAWLING', 'EXTRACTING', 'DISCOVERING_CONTACTS');

-- AlterTable
ALTER TABLE "PipelineRun" ADD COLUMN     "currentStage" "PipelineStage";
