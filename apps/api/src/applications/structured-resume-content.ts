import type { Prisma } from '@prisma/client';
import type { StructuredResume } from '@job-tracker/shared-types';

/** Narrows Prisma's opaque JsonValue to StructuredResume by checking for its two required top-level fields. */
export function isStructuredResume(content: Prisma.JsonValue): content is StructuredResume & Prisma.JsonValue {
  return (
    typeof content === 'object' &&
    content !== null &&
    !Array.isArray(content) &&
    typeof (content as Record<string, unknown>).contactLine === 'string' &&
    Array.isArray((content as Record<string, unknown>).sections)
  );
}
