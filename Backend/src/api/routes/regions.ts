import { Router, Request, Response } from "express";
import { ApiErrorResponse } from "../contracts";

/**
 * Country/region metadata (issue #638).
 *
 * `country_iso` in the price-vault contract (see
 * Contract/contracts/price-vault/src/lib.rs) is an ISO country code Symbol
 * (e.g. "NG", "KE") with no fixed enum on-chain — this module is the single
 * place that defines which country codes the API supports, along with each
 * one's display name and region grouping.
 */
export interface CountryDefinition {
  /** ISO 3166-1 alpha-2 code — must match the Symbol submitted on-chain. */
  iso: string;
  /** Display name. */
  name: string;
  /** Region grouping. */
  region: string;
}

export const COUNTRIES: readonly CountryDefinition[] = [
  { iso: "NG", name: "Nigeria", region: "West Africa" },
  { iso: "KE", name: "Kenya", region: "East Africa" },
  { iso: "GH", name: "Ghana", region: "West Africa" },
  { iso: "ZA", name: "South Africa", region: "Southern Africa" },
  { iso: "EG", name: "Egypt", region: "North Africa" },
];

const COUNTRY_BY_ISO = new Map(COUNTRIES.map((c) => [c.iso, c]));

/** True when `iso` is one of the supported country codes. */
export function isSupportedCountry(iso: string): boolean {
  return typeof iso === "string" && COUNTRY_BY_ISO.has(iso);
}

export function createRegionsRouter(): Router {
  const router = Router();

  /**
   * GET /regions/countries
   * Lists every supported country with its ISO code, display name, and region.
   */
  router.get(
    "/countries",
    (_req: Request, res: Response<{ countries: CountryDefinition[] }>): void => {
      res.json({ countries: [...COUNTRIES] });
    }
  );

  /**
   * GET /regions/countries/:iso
   * Returns a single country's metadata, validating the code against the
   * supported set.
   */
  router.get(
    "/countries/:iso",
    (req: Request, res: Response<CountryDefinition | ApiErrorResponse>): void => {
      const iso = req.params.iso.toUpperCase();

      if (!isSupportedCountry(iso)) {
        res.status(400).json({
          error: `Unsupported country code "${iso}". Supported codes: ${[...COUNTRY_BY_ISO.keys()].join(", ")}`,
          code: "UNSUPPORTED_COUNTRY",
        });
        return;
      }

      res.json(COUNTRY_BY_ISO.get(iso) as CountryDefinition);
    }
  );

  /**
   * GET /regions
   * Lists the distinct region groupings and the country codes in each.
   */
  router.get(
    "/",
    (_req: Request, res: Response<{ regions: { region: string; countries: string[] }[] }>): void => {
      const byRegion = new Map<string, string[]>();
      for (const c of COUNTRIES) {
        const list = byRegion.get(c.region) ?? [];
        list.push(c.iso);
        byRegion.set(c.region, list);
      }
      res.json({
        regions: [...byRegion.entries()].map(([region, countries]) => ({ region, countries })),
      });
    }
  );

  return router;
}
