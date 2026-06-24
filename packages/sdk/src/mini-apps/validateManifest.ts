import Ajv from "ajv";
import { InvalidManifestError } from "../errors";

const ALLOWED_PERMISSIONS = [
  "wallet.read",
  "wallet.sign",
  "profile.read",
  "post.create",
] as const;

const HTTPS_PATTERN = "^https://";

const manifestSchema = {
  type: "object",
  properties: {
    name: {
      type: "string",
      minLength: 1,
      maxLength: 50,
    },
    version: {
      type: "string",
      // Semantic versioning: MAJOR.MINOR.PATCH (e.g. 1.0.0, 2.14.3)
      pattern: "^\\d+\\.\\d+\\.\\d+$",
    },
    description: {
      type: "string",
      minLength: 1,
      maxLength: 200,
    },
    entryPoint: {
      type: "string",
      // Must be an absolute HTTPS URL for security — HTTP not accepted.
      pattern: HTTPS_PATTERN,
      minLength: 9, // "https://x" is the shortest valid value
      maxLength: 2048,
    },
    icon: {
      type: "string",
      // Optional, but when present must be an absolute HTTPS URL.
      pattern: HTTPS_PATTERN,
      minLength: 9,
      maxLength: 2048,
    },
    permissions: {
      type: "array",
      items: {
        type: "string",
        enum: [...ALLOWED_PERMISSIONS],
      },
      minItems: 1,
      maxItems: ALLOWED_PERMISSIONS.length,
      uniqueItems: true,
    },
    author: {
      type: "string",
      minLength: 1,
      maxLength: 100,
    },
    homepage: {
      type: "string",
      pattern: HTTPS_PATTERN,
      minLength: 9,
      maxLength: 2048,
    },
  },
  required: ["name", "version", "entryPoint", "permissions"],
  additionalProperties: false,
};

export type PermissionScope = (typeof ALLOWED_PERMISSIONS)[number];

export interface MiniAppManifest {
  name: string;
  version: string;
  description?: string;
  entryPoint: string;
  icon?: string;
  permissions: PermissionScope[];
  author?: string;
  homepage?: string;
}

const ajv = new Ajv({ allErrors: true });
const validate = ajv.compile(manifestSchema);

/**
 * Validates an unknown value against the MiniAppManifest JSON schema.
 *
 * Enforces:
 * - Required fields: name, version (semver), entryPoint (HTTPS URL), permissions (non-empty)
 * - Optional fields: description, icon (HTTPS URL), author, homepage (HTTPS URL)
 * - No extra properties beyond the defined schema
 * - Permissions must be from the allowed set and must not repeat
 *
 * @param manifest - Value to validate; typically parsed from JSON.
 * @returns The validated manifest cast to `MiniAppManifest`.
 * @throws {InvalidManifestError} When any schema constraint is violated.
 */
export function validateManifest(manifest: unknown): MiniAppManifest {
  if (manifest === null || typeof manifest !== "object") {
    throw new InvalidManifestError("Manifest must be a non-null object.");
  }

  const valid = validate(manifest);
  if (!valid) {
    const errorsText = ajv.errorsText(validate.errors, { separator: "; " });
    throw new InvalidManifestError(`Manifest validation failed: ${errorsText}`);
  }

  return manifest as MiniAppManifest;
}
