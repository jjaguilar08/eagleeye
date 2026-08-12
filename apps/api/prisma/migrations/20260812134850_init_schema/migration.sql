-- CreateEnum
CREATE TYPE "PipelineRunStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'STOPPED');

-- CreateEnum
CREATE TYPE "ArticleStatus" AS ENUM ('DISCOVERED', 'CRAWLED', 'EXTRACTED', 'FAILED');

-- CreateEnum
CREATE TYPE "AuthorExtractionMethod" AS ENUM ('JSON_LD', 'META_TAG', 'BYLINE_PATTERN', 'AUTHOR_BIO_PAGE', 'STAFF_PAGE', 'NONE');

-- CreateEnum
CREATE TYPE "ContactAttemptMethod" AS ENUM ('CONTACT_PAGE_SCAN', 'EMAIL_PATTERN_GUESS', 'OUTLET_FALLBACK', 'MANUAL');

-- CreateEnum
CREATE TYPE "ContactAttemptStatus" AS ENUM ('FOUND', 'OUTLET_FALLBACK', 'NEEDS_REVIEW', 'FAILED');

-- CreateEnum
CREATE TYPE "EmailThreadStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'SENT', 'REPLIED', 'CLOSED');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('OUTBOUND', 'INBOUND');

-- CreateTable
CREATE TABLE "PipelineRun" (
    "id" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "maxArticles" INTEGER NOT NULL,
    "maxDrafts" INTEGER NOT NULL,
    "maxSends" INTEGER NOT NULL,
    "status" "PipelineRunStatus" NOT NULL DEFAULT 'PENDING',
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PipelineRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Article" (
    "id" TEXT NOT NULL,
    "pipelineRunId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "sourceDomain" TEXT NOT NULL,
    "status" "ArticleStatus" NOT NULL DEFAULT 'DISCOVERED',
    "discoveredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Article_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Author" (
    "id" TEXT NOT NULL,
    "articleId" TEXT NOT NULL,
    "name" TEXT,
    "extractionMethod" "AuthorExtractionMethod" NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "profileUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Author_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContactAttempt" (
    "id" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "method" "ContactAttemptMethod" NOT NULL,
    "emailCandidate" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL,
    "status" "ContactAttemptStatus" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailThread" (
    "id" TEXT NOT NULL,
    "articleId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "contactAttemptId" TEXT,
    "recipientEmail" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "status" "EmailThreadStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "direction" "MessageDirection" NOT NULL,
    "aiGenerated" BOOLEAN NOT NULL,
    "approvedByUser" BOOLEAN NOT NULL DEFAULT false,
    "body" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "automationEnabled" BOOLEAN NOT NULL DEFAULT false,
    "searchTopic" TEXT NOT NULL DEFAULT 'outdoor/hunting/shooting sports retail',
    "maxArticlesPerRun" INTEGER NOT NULL DEFAULT 10,
    "maxDraftsPerRun" INTEGER NOT NULL DEFAULT 10,
    "maxSendsPerRun" INTEGER NOT NULL DEFAULT 5,
    "dailySendCap" INTEGER NOT NULL DEFAULT 10,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhitelistEntry" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "label" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhitelistEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PipelineRun_status_idx" ON "PipelineRun"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Article_url_key" ON "Article"("url");

-- CreateIndex
CREATE INDEX "Article_pipelineRunId_idx" ON "Article"("pipelineRunId");

-- CreateIndex
CREATE INDEX "Article_sourceDomain_idx" ON "Article"("sourceDomain");

-- CreateIndex
CREATE UNIQUE INDEX "Author_articleId_key" ON "Author"("articleId");

-- CreateIndex
CREATE INDEX "Author_extractionMethod_idx" ON "Author"("extractionMethod");

-- CreateIndex
CREATE INDEX "ContactAttempt_authorId_idx" ON "ContactAttempt"("authorId");

-- CreateIndex
CREATE INDEX "ContactAttempt_status_idx" ON "ContactAttempt"("status");

-- CreateIndex
CREATE INDEX "EmailThread_articleId_idx" ON "EmailThread"("articleId");

-- CreateIndex
CREATE INDEX "EmailThread_authorId_idx" ON "EmailThread"("authorId");

-- CreateIndex
CREATE INDEX "EmailThread_contactAttemptId_idx" ON "EmailThread"("contactAttemptId");

-- CreateIndex
CREATE INDEX "EmailThread_status_idx" ON "EmailThread"("status");

-- CreateIndex
CREATE INDEX "Message_threadId_idx" ON "Message"("threadId");

-- CreateIndex
CREATE UNIQUE INDEX "WhitelistEntry_email_key" ON "WhitelistEntry"("email");

-- AddForeignKey
ALTER TABLE "Article" ADD CONSTRAINT "Article_pipelineRunId_fkey" FOREIGN KEY ("pipelineRunId") REFERENCES "PipelineRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Author" ADD CONSTRAINT "Author_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "Article"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactAttempt" ADD CONSTRAINT "ContactAttempt_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "Author"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailThread" ADD CONSTRAINT "EmailThread_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "Article"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailThread" ADD CONSTRAINT "EmailThread_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "Author"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailThread" ADD CONSTRAINT "EmailThread_contactAttemptId_fkey" FOREIGN KEY ("contactAttemptId") REFERENCES "ContactAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "EmailThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;
