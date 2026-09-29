import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class LinkedinService {
  constructor(private readonly prisma: PrismaService) {}

  getProfile() {
    return this.prisma.linkedinProfile.findFirst();
  }

  /**
   * Compares the latest ACCEPTED LinkedIn session's createdAt against the max
   * updatedAt/createdAt/addedAt across every upstream input the agent reads:
   * candidate profile, the four entry tables, uploaded Stories/Resume files
   * (add/delete-only, so createdAt is the right change signal), and connected
   * repos (same reasoning, addedAt). Also compares against Application data
   * (jdText/status/lastMessageReceivedDate) since the staged sourcing tool
   * depends on it, via updatedAt.
   */
  async getStaleness(): Promise<{ stale: boolean; lastGeneratedAt: string | null }> {
    const lastAccepted = await this.prisma.generationSession.findFirst({
      where: { scope: 'LINKEDIN', status: 'ACCEPTED' },
      orderBy: { createdAt: 'desc' },
    });

    if (!lastAccepted) {
      return { stale: true, lastGeneratedAt: null };
    }

    const [
      profile,
      workExperience,
      education,
      internships,
      projects,
      stories,
      resumeFiles,
      repos,
      applications,
    ] = await Promise.all([
      this.prisma.resumePromptTemplate.findFirst({ orderBy: { updatedAt: 'desc' } }),
      this.prisma.workExperienceEntry.findFirst({ orderBy: { updatedAt: 'desc' } }),
      this.prisma.educationEntry.findFirst({ orderBy: { updatedAt: 'desc' } }),
      this.prisma.internshipEntry.findFirst({ orderBy: { updatedAt: 'desc' } }),
      this.prisma.projectEntry.findFirst({ orderBy: { updatedAt: 'desc' } }),
      this.prisma.storyFile.findFirst({ orderBy: { createdAt: 'desc' } }),
      this.prisma.resumeFile.findFirst({ orderBy: { createdAt: 'desc' } }),
      this.prisma.connectedRepo.findFirst({ orderBy: { addedAt: 'desc' } }),
      this.prisma.application.findFirst({ orderBy: { updatedAt: 'desc' } }),
    ]);

    const timestamps: Date[] = [
      profile?.updatedAt,
      workExperience?.updatedAt,
      education?.updatedAt,
      internships?.updatedAt,
      projects?.updatedAt,
      stories?.createdAt,
      resumeFiles?.createdAt,
      repos?.addedAt,
      applications?.updatedAt,
    ].filter((d): d is Date => d != null);

    const latestChange = timestamps.length
      ? new Date(Math.max(...timestamps.map((d) => d.getTime())))
      : null;

    const stale = latestChange ? latestChange > lastAccepted.createdAt : false;
    return { stale, lastGeneratedAt: lastAccepted.createdAt.toISOString() };
  }
}
