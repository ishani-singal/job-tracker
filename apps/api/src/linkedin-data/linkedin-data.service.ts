import { Injectable, BadRequestException } from '@nestjs/common';
import AdmZip from 'adm-zip';
import { parse } from 'csv-parse/sync';
import { PrismaService } from '../prisma/prisma.service';

/**
 * LinkedIn's export ZIP (Settings > Get a copy of your data) contains dozens
 * of CSVs; we only want Connections.csv and messages.csv. Connections.csv
 * specifically ships with 3 preamble/notes lines before the real header row
 * (a longstanding LinkedIn export quirk) — detect the header by scanning for
 * a line starting with "First Name" rather than assuming a fixed line count.
 */
function findCsvInZip(zip: AdmZip, filename: string): string | null {
  const entry = zip
    .getEntries()
    .find((e) => e.entryName.toLowerCase().endsWith(filename.toLowerCase()));
  return entry ? entry.getData().toString('utf-8') : null;
}

function stripPreamble(csvText: string, headerStartsWith: string): string {
  const lines = csvText.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) =>
    line.toLowerCase().startsWith(headerStartsWith.toLowerCase()),
  );
  if (headerIndex <= 0) return csvText;
  return lines.slice(headerIndex).join('\n');
}

function parseLinkedinDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return isNaN(parsed.getTime()) ? undefined : parsed;
}

@Injectable()
export class LinkedinDataService {
  constructor(private readonly prisma: PrismaService) {}

  async importZip(buffer: Buffer) {
    let zip: AdmZip;
    try {
      zip = new AdmZip(buffer);
    } catch {
      throw new BadRequestException('Uploaded file is not a valid ZIP archive');
    }

    const connectionsCsv = findCsvInZip(zip, 'Connections.csv');
    const messagesCsv = findCsvInZip(zip, 'messages.csv');

    if (!connectionsCsv && !messagesCsv) {
      throw new BadRequestException(
        'Could not find Connections.csv or messages.csv in this export — is this a LinkedIn data export ZIP?',
      );
    }

    const linkedinImport = await this.prisma.linkedinImport.create({ data: {} });

    if (connectionsCsv) {
      const cleaned = stripPreamble(connectionsCsv, 'First Name');
      const rows = parse(cleaned, { columns: true, skip_empty_lines: true }) as Record<
        string,
        string
      >[];
      if (rows.length > 0) {
        await this.prisma.linkedinConnection.createMany({
          data: rows.map((row) => ({
            importId: linkedinImport.id,
            firstName: row['First Name'] || undefined,
            lastName: row['Last Name'] || undefined,
            url: row['URL'] || undefined,
            emailAddress: row['Email Address'] || undefined,
            company: row['Company'] || undefined,
            position: row['Position'] || undefined,
            connectedOn: parseLinkedinDate(row['Connected On']),
          })),
        });
      }
    }

    if (messagesCsv) {
      const rows = parse(messagesCsv, { columns: true, skip_empty_lines: true }) as Record<
        string,
        string
      >[];
      if (rows.length > 0) {
        await this.prisma.linkedinMessageThread.createMany({
          data: rows.map((row) => ({
            importId: linkedinImport.id,
            conversationId: row['CONVERSATION ID'] || row['Conversation ID'] || 'unknown',
            fromName: row['FROM'] || row['From'] || undefined,
            toName: row['TO'] || row['To'] || undefined,
            content: row['CONTENT'] || row['Content'] || undefined,
            sentAt: parseLinkedinDate(row['DATE'] || row['Date']),
          })),
        });
      }
    }

    return this.getLatestSummary();
  }

  async getLatestSummary() {
    const latest = await this.prisma.linkedinImport.findFirst({
      orderBy: { importedAt: 'desc' },
    });
    if (!latest) return null;

    const [connectionCount, messageCount] = await Promise.all([
      this.prisma.linkedinConnection.count({ where: { importId: latest.id } }),
      this.prisma.linkedinMessageThread.count({ where: { importId: latest.id } }),
    ]);

    return { importId: latest.id, importedAt: latest.importedAt, connectionCount, messageCount };
  }

  async listConnections(search?: string) {
    const latest = await this.prisma.linkedinImport.findFirst({
      orderBy: { importedAt: 'desc' },
    });
    if (!latest) return [];

    return this.prisma.linkedinConnection.findMany({
      where: {
        importId: latest.id,
        ...(search && {
          OR: [
            { firstName: { contains: search, mode: 'insensitive' } },
            { lastName: { contains: search, mode: 'insensitive' } },
            { company: { contains: search, mode: 'insensitive' } },
            { position: { contains: search, mode: 'insensitive' } },
          ],
        }),
      },
      orderBy: { connectedOn: 'desc' },
    });
  }

  async listMessageThreads() {
    const latest = await this.prisma.linkedinImport.findFirst({
      orderBy: { importedAt: 'desc' },
    });
    if (!latest) return [];

    const messages = await this.prisma.linkedinMessageThread.findMany({
      where: { importId: latest.id },
      orderBy: { sentAt: 'asc' },
    });

    const threads = new Map<string, typeof messages>();
    for (const m of messages) {
      const group = threads.get(m.conversationId) ?? [];
      group.push(m);
      threads.set(m.conversationId, group);
    }
    return [...threads.entries()].map(([conversationId, msgs]) => ({
      conversationId,
      messageCount: msgs.length,
      lastMessageAt: msgs[msgs.length - 1]?.sentAt ?? null,
      participants: [...new Set(msgs.flatMap((m) => [m.fromName, m.toName]).filter(Boolean))],
    }));
  }

  async getThreadMessages(conversationId: string) {
    const latest = await this.prisma.linkedinImport.findFirst({
      orderBy: { importedAt: 'desc' },
    });
    if (!latest) return [];

    return this.prisma.linkedinMessageThread.findMany({
      where: { importId: latest.id, conversationId },
      orderBy: { sentAt: 'asc' },
    });
  }
}
