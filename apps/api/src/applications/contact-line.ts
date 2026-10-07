/** Adds https:// to a bare address so it works as a link target. */
function asUrl(u: string): string {
  return /^https?:\/\//i.test(u) ? u : `https://${u}`;
}

/**
 * The resume's contact line, built from the CURRENT profile every time a resume
 * is rendered (not only when it was generated), so links added later show up on
 * resumes that were already saved. Same value and order the resume agent is told
 * to use verbatim (agent/resu/definition.py):
 * email | location | phone | LinkedIn | GitHub | Portfolio. The three links are
 * markdown links — [LinkedIn](url), [GitHub](url), [Portfolio](url) — which the
 * renderers show as just those words, hyperlinked to the URL.
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
    profile.linkedinUrl ? `[LinkedIn](${asUrl(profile.linkedinUrl)})` : null,
    profile.githubUrl ? `[GitHub](${asUrl(profile.githubUrl)})` : null,
    profile.portfolioUrl ? `[Portfolio](${asUrl(profile.portfolioUrl)})` : null,
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
