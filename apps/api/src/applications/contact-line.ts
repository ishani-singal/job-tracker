/**
 * The resume's contact line, built from the CURRENT profile every time a resume
 * is rendered (not only when it was generated), so links added later — GitHub,
 * portfolio — show up on resumes that were already saved. Same value and order
 * the resume agent is told to use verbatim (agent/resu/definition.py):
 * email | location | phone | LinkedIn | GitHub | Portfolio. The portfolio is a
 * markdown link, [Portfolio](url), which the renderers show as the text
 * "Portfolio" hyperlinked to the URL; LinkedIn/GitHub show as their URLs, linked.
 */
export function buildContactLine(profile: {
  candidateEmail?: string | null;
  candidatePhone?: string | null;
  linkedinUrl?: string | null;
  githubUrl?: string | null;
  portfolioUrl?: string | null;
  locationCity?: string | null;
  locationState?: string | null;
  locationCountry?: string | null;
}): string {
  const location = [profile.locationCity, profile.locationState, profile.locationCountry].filter(Boolean).join(', ');
  return [
    profile.candidateEmail,
    location || null,
    profile.candidatePhone,
    profile.linkedinUrl,
    profile.githubUrl,
    profile.portfolioUrl ? `[Portfolio](${profile.portfolioUrl})` : null,
  ]
    .filter(Boolean)
    .join(' | ');
}

export interface ContactPart {
  /** The text shown. */
  text: string;
  /** Where it links, if it's a link. */
  url?: string;
}

/** Splits a contact line into its " | " parts, resolving links. */
export function parseContactLine(contactLine: string): ContactPart[] {
  return contactLine
    .split('|')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((part) => {
      const md = part.match(/^\[(.+)\]\((.+)\)$/);
      if (md) return { text: md[1], url: md[2] };
      if (/linkedin\.com|github\.com/i.test(part)) {
        return { text: part, url: part.startsWith('http') ? part : `https://${part}` };
      }
      return { text: part };
    });
}
