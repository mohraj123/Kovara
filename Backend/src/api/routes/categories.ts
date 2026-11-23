import { Router, Request, Response } from "express";
import { ApiErrorResponse } from "../contracts";

/**
 * Canonical price-basket categories (issue #639).
 *
 * These match the cost-of-living basket categories referenced by the
 * `price-vault` contract (see Contract/contracts/price-vault/src/lib.rs,
 * "daily cost-of-living basket") — the contract itself accepts any Soroban
 * `Symbol` as a category, so this module is the single place that narrows
 * that down to the set of categories the API actually supports, along with
 * the item names and unit each one expects.
 */
export interface CategoryDefinition {
  /** Stable machine key — must match the Symbol submitted on-chain. */
  key: string;
  /** Human-readable label. */
  label: string;
  /** Representative basket item names tracked under this category. */
  items: string[];
  /** Unit expected for price submissions in this category. */
  unit: "per_unit" | "per_month" | "per_kwh" | "per_liter";
}

export const CATEGORIES: readonly CategoryDefinition[] = [
  {
    key: "Food",
    label: "Food",
    items: ["bread", "rice", "milk", "eggs", "chicken"],
    unit: "per_unit",
  },
  {
    key: "Rent",
    label: "Rent",
    items: ["1-bedroom apartment", "studio apartment"],
    unit: "per_month",
  },
  {
    key: "Utilities",
    label: "Utilities",
    items: ["electricity", "water", "internet"],
    unit: "per_kwh",
  },
  {
    key: "Transport",
    label: "Transport",
    items: ["fuel", "public transit pass"],
    unit: "per_liter",
  },
];

const CATEGORY_KEYS = new Set(CATEGORIES.map((c) => c.key));

/** True when `key` is one of the supported basket categories. */
export function isSupportedCategory(key: string): boolean {
  return typeof key === "string" && CATEGORY_KEYS.has(key);
}

export function createCategoriesRouter(): Router {
  const router = Router();

  /**
   * GET /categories
   * Lists every supported basket category with its item names and unit.
   */
  router.get("/", (_req: Request, res: Response<{ categories: CategoryDefinition[] }>): void => {
    res.json({ categories: [...CATEGORIES] });
  });

  /**
   * GET /categories/:key
   * Returns a single category's basket metadata, validating that the
   * category is one of the supported set.
   */
  router.get(
    "/:key",
    (req: Request, res: Response<CategoryDefinition | ApiErrorResponse>): void => {
      const { key } = req.params;

      if (!isSupportedCategory(key)) {
        res.status(400).json({
          error: `Unsupported category "${key}". Supported categories: ${[...CATEGORY_KEYS].join(", ")}`,
          code: "UNSUPPORTED_CATEGORY",
        });
        return;
      }

      const category = CATEGORIES.find((c) => c.key === key) as CategoryDefinition;
      res.json(category);
    }
  );

  return router;
}
