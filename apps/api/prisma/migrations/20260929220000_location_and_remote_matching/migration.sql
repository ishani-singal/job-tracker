-- AlterTable
ALTER TABLE "DiscoveredRole" ADD COLUMN     "roleIsRemote" BOOLEAN,
ADD COLUMN     "roleCountry" TEXT,
ADD COLUMN     "roleState" TEXT,
ADD COLUMN     "roleCity" TEXT,
ADD COLUMN     "locationMismatch" BOOLEAN;

-- AlterTable
ALTER TABLE "ResumePromptTemplate" DROP COLUMN "locationZip",
ADD COLUMN     "locationCountry" TEXT,
ADD COLUMN     "locationState" TEXT,
ADD COLUMN     "locationCity" TEXT,
ADD COLUMN     "openToRemote" BOOLEAN NOT NULL DEFAULT false;
