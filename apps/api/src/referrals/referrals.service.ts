import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SessionsService } from '../sessions/sessions.service';

export const REFERRAL_TONES = ['friend', 'colleague', 'acquaintance', 'mentor'] as const;
export type ReferralTone = (typeof REFERRAL_TONES)[number];

export const REFERRAL_CHANNELS = ['linkedin', 'whatsapp', 'text', 'email'] as const;
export type ReferralChannel = (typeof REFERRAL_CHANNELS)[number];

/** One resume has to cover every selected JD, so the number of roles is capped. */
export const MAX_REFERRAL_ROLES = 10;
/** With a minimum score, every role scoring above it is kept, so the pool can be larger. */
export const MAX_REFERRAL_POOL_WITH_MIN_SCORE = 40;

export interface ContactInput {
  name?: string;
  linkedinUrl?: string | null;
  email?: string | null;
  phone?: string | null;
}

function clean(v: string | null | undefined): string | null {
  const t = v?.trim();
  return t ? t : null;
}

@Injectable()
export class ReferralsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
  ) {}

  listContacts(companyId: string) {
    return this.prisma.companyContact.findMany({
      where: { companyId },
      orderBy: { createdAt: 'asc' },
      include: {
        // resumeContent is large and only needed by the download endpoints.
        referrals: {
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            contactId: true,
            tone: true,
            channel: true,
            roles: true,
            message: true,
            scores: true,
            targetMet: true,
            note: true,
            createdAt: true,
          },
        },
      },
    });
  }

  async createContact(companyId: string, input: ContactInput) {
    const name = clean(input.name);
    if (!name) throw new BadRequestException('name is required');
    const company = await this.prisma.trackedCompany.findUnique({ where: { id: companyId } });
    if (!company) throw new NotFoundException(`Company ${companyId} not found`);
    return this.prisma.companyContact.create({
      data: {
        companyId,
        name,
        linkedinUrl: clean(input.linkedinUrl),
        email: clean(input.email),
        phone: clean(input.phone),
      },
    });
  }

  async updateContact(id: string, input: ContactInput) {
    const name = input.name === undefined ? undefined : clean(input.name);
    if (name === null) throw new BadRequestException('name cannot be empty');
    try {
      return await this.prisma.companyContact.update({
        where: { id },
        data: {
          ...(name !== undefined && { name }),
          ...(input.linkedinUrl !== undefined && { linkedinUrl: clean(input.linkedinUrl) }),
          ...(input.email !== undefined && { email: clean(input.email) }),
          ...(input.phone !== undefined && { phone: clean(input.phone) }),
        },
      });
    } catch {
      throw new NotFoundException(`Contact ${id} not found`);
    }
  }

  async deleteContact(id: string) {
    try {
      await this.prisma.companyContact.delete({ where: { id } });
    } catch {
      throw new NotFoundException(`Contact ${id} not found`);
    }
    return { deleted: true };
  }

  /** Validates the request and starts the REFERRAL chat session that fetches
   * the JDs, builds + ATS-checks the resume and drafts the message. */
  async startReferral(contactId: string, tone: string, channel: string, roleIds: string[], minScore?: number) {
    if (!(REFERRAL_TONES as readonly string[]).includes(tone)) {
      throw new BadRequestException(`tone must be one of: ${REFERRAL_TONES.join(', ')}`);
    }
    if (!(REFERRAL_CHANNELS as readonly string[]).includes(channel)) {
      throw new BadRequestException(`channel must be one of: ${REFERRAL_CHANNELS.join(', ')}`);
    }
    const ids = [...new Set(roleIds ?? [])];
    if (minScore !== undefined && !(Number.isInteger(minScore) && minScore >= 50 && minScore <= 100)) {
      throw new BadRequestException('minScore must be an integer between 50 and 100');
    }
    const maxRoles = minScore !== undefined ? MAX_REFERRAL_POOL_WITH_MIN_SCORE : MAX_REFERRAL_ROLES;
    if (ids.length < 1 || ids.length > maxRoles) {
      throw new BadRequestException(`Select between 1 and ${maxRoles} roles`);
    }
    const contact = await this.prisma.companyContact.findUnique({ where: { id: contactId } });
    if (!contact) throw new NotFoundException(`Contact ${contactId} not found`);
    const roles = await this.prisma.discoveredRole.findMany({
      where: { id: { in: ids }, companyId: contact.companyId },
      select: { id: true },
    });
    if (roles.length !== ids.length) {
      throw new BadRequestException("Every selected role must belong to this contact's company");
    }
    return this.sessions.startReferral(contactId, tone, channel, ids, minScore);
  }

  async getReferral(id: string) {
    const referral = await this.prisma.referralRequest.findUnique({
      where: { id },
      include: { contact: { include: { company: true } } },
    });
    if (!referral) throw new NotFoundException(`Referral ${id} not found`);
    return referral;
  }
}
