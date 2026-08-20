-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "providerEmailId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Message_providerEmailId_key" ON "Message"("providerEmailId");
