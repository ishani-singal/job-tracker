-- AlterTable
ALTER TABLE "InternshipEntry" ADD COLUMN     "isClassProject" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isFamilyBusiness" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "WorkExperienceEntry" ADD COLUMN     "isFamilyBusiness" BOOLEAN NOT NULL DEFAULT false;

