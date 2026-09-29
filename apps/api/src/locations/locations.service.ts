import { Injectable } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import cities from 'all-the-cities';
import { getName as getCountryName, getCodes as getCountryCodes } from 'country-list';

// GeoNames admin1CodesASCII.txt: "<countryCode>.<adminCode>\t<name>\t<asciiName>\t<geonameId>"
// Maps e.g. "IN.19" -> "Karnataka", "US.WA" -> "Washington" — needed because
// all-the-cities' adminCode is GeoNames' own code (numeric for most countries,
// not the two-letter US-style code), so it can't be formatted without this.
const ADMIN1_PATH = join(__dirname, 'data', 'admin1CodesASCII.txt');

function loadAdmin1Names(): Map<string, string> {
  const map = new Map<string, string>();
  const raw = readFileSync(ADMIN1_PATH, 'utf-8');
  for (const line of raw.split('\n')) {
    const [code, name] = line.split('\t');
    if (code && name) map.set(code, name);
  }
  return map;
}

export interface LocationSuggestion {
  label: string; // "Seattle, Washington, United States"
  city: string;
  region: string | null;
  country: string;
}

export interface CountryOption {
  code: string; // ISO 3166-1 alpha-2, e.g. "US"
  name: string;
}

export interface StateOption {
  code: string; // GeoNames admin1 code, e.g. "WA" or a numeric code for non-US countries
  name: string;
}

// country-list ships official ISO long-form names ("United States of America
// (the)", "Korea (the Republic of)") — override the common awkward ones with
// the casual names people actually expect on a resume.
const COUNTRY_NAME_OVERRIDES: Record<string, string> = {
  US: 'United States',
  GB: 'United Kingdom',
  KR: 'South Korea',
  KP: 'North Korea',
  NL: 'Netherlands',
  PH: 'Philippines',
  CZ: 'Czech Republic',
  RU: 'Russia',
  VN: 'Vietnam',
  TW: 'Taiwan',
  IR: 'Iran',
  SY: 'Syria',
  LA: 'Laos',
  MD: 'Moldova',
  TZ: 'Tanzania',
  BO: 'Bolivia',
  VE: 'Venezuela',
  BN: 'Brunei',
};

function formatCountryName(code: string): string {
  return COUNTRY_NAME_OVERRIDES[code] ?? getCountryName(code) ?? code;
}

@Injectable()
export class LocationsService {
  private readonly admin1Names = loadAdmin1Names();

  search(query: string, opts?: { limit?: number; country?: string; state?: string }): LocationSuggestion[] {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    const limit = opts?.limit ?? 8;

    const matches: { city: (typeof cities)[number]; score: number }[] = [];
    for (const city of cities) {
      const name = city.name.toLowerCase();
      if (!name.startsWith(q)) continue;
      if (opts?.country && city.country !== opts.country) continue;
      if (opts?.state && city.adminCode !== opts.state) continue;
      // Prefer higher-population matches when many cities share a prefix.
      matches.push({ city, score: city.population ?? 0 });
      if (matches.length > 500) break; // cap scan cost on very short/common prefixes
    }

    matches.sort((a, b) => b.score - a.score);

    return matches.slice(0, limit).map(({ city }) => {
      const region = this.admin1Names.get(`${city.country}.${city.adminCode}`) ?? null;
      const country = formatCountryName(city.country);
      const label = [city.name, region, country].filter(Boolean).join(', ');
      return { label, city: city.name, region, country };
    });
  }

  /** All ISO countries, sorted by display name — for a country dropdown. */
  listCountries(): CountryOption[] {
    return getCountryCodes()
      .map((code) => ({ code, name: formatCountryName(code) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** States/provinces/regions for one country, derived from the same
   * GeoNames admin1 table used to label search() results — so a state
   * selected here always matches what search()/city data can filter by. */
  listStates(countryCode: string): StateOption[] {
    const prefix = `${countryCode}.`;
    const states: StateOption[] = [];
    for (const [key, name] of this.admin1Names) {
      if (!key.startsWith(prefix)) continue;
      states.push({ code: key.slice(prefix.length), name });
    }
    return states.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Resolves a stored country code (e.g. "US") to its display name (e.g.
   * "United States") — the candidate profile stores codes from the dropdown,
   * but a JD's extracted location is a free-form name, so callers comparing
   * the two need both sides in the same form. */
  countryName(countryCode: string): string {
    return formatCountryName(countryCode);
  }

  /** Resolves a stored (countryCode, stateCode) pair to the state's display
   * name — same rationale as countryName(). */
  stateName(countryCode: string, stateCode: string): string | null {
    return this.admin1Names.get(`${countryCode}.${stateCode}`) ?? null;
  }
}
