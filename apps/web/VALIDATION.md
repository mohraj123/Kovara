# Web Form Validation

This document describes the input validation and sanitisation strategy for all
Kovara web forms.

---

## Validation Utility

All validators live in `src/lib/validate.ts` and are pure functions that return
`{ valid: boolean; error?: string }`. They can be used in both client components
and server actions.

| Validator                | Rules                                                 |
| ------------------------ | ----------------------------------------------------- |
| `validatePostContent`    | Non-empty after sanitisation; max 280 characters      |
| `validateUsername`       | Alphanumeric + `_` only; 3–32 characters              |
| `validateStellarAddress` | Starts with `G` or `C`; exactly 56 base-32 characters |
| `validateAmount`         | Numeric; greater than zero                            |
| `validateSearchQuery`    | Non-empty; max 200 characters                         |

### Sanitisation

`sanitisePostContent` strips `<script>` blocks, all HTML tags, `javascript:`
URIs, and inline event handlers (`on*=`) before validation and before passing
content to a contract call.

---

## Form Components

| Component     | Fields                     | Validators applied                           |
| ------------- | -------------------------- | -------------------------------------------- |
| `PostForm`    | `content`                  | `sanitisePostContent`, `validatePostContent` |
| `ProfileForm` | `username`, `creatorToken` | `validateUsername`, `validateStellarAddress` |
| `TipForm`     | `tokenAddress`, `amount`   | `validateStellarAddress`, `validateAmount`   |
| `SearchBar`   | `query`                    | `validateSearchQuery`                        |

---

## Accessible Error Messages

The `FieldError` component renders errors with:

- `role="alert"` — announces the error to screen readers immediately
- `aria-live="polite"` — updates are read without interrupting the user
- Each input carries `aria-describedby` pointing to its error element and
  `aria-invalid="true"` when in an error state

---

## Contract Call Safety

No raw user input is passed to contract calls. Every form validates and
sanitises values before the `onSubmit` callback is invoked. The callback
receives only clean, validated data.
# Web Form Validation

This document describes the input validation and sanitisation strategy for all
Kovara web forms.

---

## Validation Utility

All validators live in `src/lib/validate.ts` and are pure functions that return
`{ valid: boolean; error?: string }`. They can be used in both client components
and server actions.

| Validator                | Rules                                                 |
| ------------------------ | ----------------------------------------------------- |
| `validatePostContent`    | Non-empty after sanitisation; max 280 characters      |
| `validateUsername`       | Alphanumeric + `_` only; 3–32 characters              |
| `validateStellarAddress` | Starts with `G` or `C`; exactly 56 base-32 characters |
| `validateAmount`         | Numeric; greater than zero                            |
| `validateSearchQuery`    | Non-empty; max 200 characters                         |

### Sanitisation

`sanitisePostContent` strips `<script>` blocks, all HTML tags, `javascript:`
URIs, and inline event handlers (`on*=`) before validation and before passing
content to a contract call.

---

## Form Components

| Component     | Fields                     | Validators applied                           |
| ------------- | -------------------------- | -------------------------------------------- |
| `PostForm`    | `content`                  | `sanitisePostContent`, `validatePostContent` |
| `ProfileForm` | `username`, `creatorToken` | `validateUsername`, `validateStellarAddress` |
| `TipForm`     | `tokenAddress`, `amount`   | `validateStellarAddress`, `validateAmount`   |
| `SearchBar`   | `query`                    | `validateSearchQuery`                        |

---

## Accessible Error Messages

The `FieldError` component renders errors with:

- `role="alert"` — announces the error to screen readers immediately
- `aria-live="polite"` — updates are read without interrupting the user
- Each input carries `aria-describedby` pointing to its error element and
  `aria-invalid="true"` when in an error state

---

## Contract Call Safety

No raw user input is passed to contract calls. Every form validates and
sanitises values before the `onSubmit` callback is invoked. The callback
receives only clean, validated data.
# Web Form Validation

This document describes the input validation and sanitisation strategy for all
Kovara web forms.

---

## Validation Utility

All validators live in `src/lib/validate.ts` and are pure functions that return
`{ valid: boolean; error?: string }`. They can be used in both client components
and server actions.

| Validator                | Rules                                                 |
| ------------------------ | ----------------------------------------------------- |
| `validatePostContent`    | Non-empty after sanitisation; max 280 characters      |
| `validateUsername`       | Alphanumeric + `_` only; 3–32 characters              |
| `validateStellarAddress` | Starts with `G` or `C`; exactly 56 base-32 characters |
| `validateAmount`         | Numeric; greater than zero                            |
| `validateSearchQuery`    | Non-empty; max 200 characters                         |

### Sanitisation

`sanitisePostContent` strips `<script>` blocks, all HTML tags, `javascript:`
URIs, and inline event handlers (`on*=`) before validation and before passing
content to a contract call.

---

## Form Components

| Component     | Fields                     | Validators applied                           |
| ------------- | -------------------------- | -------------------------------------------- |
| `PostForm`    | `content`                  | `sanitisePostContent`, `validatePostContent` |
| `ProfileForm` | `username`, `creatorToken` | `validateUsername`, `validateStellarAddress` |
| `TipForm`     | `tokenAddress`, `amount`   | `validateStellarAddress`, `validateAmount`   |
| `SearchBar`   | `query`                    | `validateSearchQuery`                        |

---

## Accessible Error Messages

The `FieldError` component renders errors with:

- `role="alert"` — announces the error to screen readers immediately
- `aria-live="polite"` — updates are read without interrupting the user
- Each input carries `aria-describedby` pointing to its error element and
  `aria-invalid="true"` when in an error state

---

## Contract Call Safety

No raw user input is passed to contract calls. Every form validates and
sanitises values before the `onSubmit` callback is invoked. The callback
receives only clean, validated data.
