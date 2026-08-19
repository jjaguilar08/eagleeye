-- AlterTable
ALTER TABLE "Setting" ADD COLUMN     "companyName" TEXT NOT NULL DEFAULT 'Timberline Outdoor Co.',
ADD COLUMN     "productPitch" TEXT NOT NULL DEFAULT 'outdoor, hunting, and shooting-sports gear',
ADD COLUMN     "senderName" TEXT NOT NULL DEFAULT 'Alex Morgan',
ADD COLUMN     "senderRole" TEXT NOT NULL DEFAULT 'Partnerships Lead';
