# Backend documentation

Reference documentation for the Kovara backend (`Backend/`): the indexer that
streams Kovara Social contract events into PostgreSQL and the REST API that serves
them.

| Document | Covers |
| --- | --- |
| [`architecture.md`](./architecture.md) | How the service is wired: startup, persistence and the event state machine, the event pipeline and dispatch table, the API middleware stack, observability, and verified known gaps. |
| [`api-contracts.md`](./api-contracts.md) | The REST surface: endpoints, parameters, response shapes, error codes, versioning, and the OpenAPI coverage. |
| [`runbook.md`](./runbook.md) | Deployment, configuration reference, migrations, replay/recovery, incident triage, rollback, and backup/scaling notes. |

`Backend/README.md` remains the quick-start and feature overview. When it and these
pages disagree, the code on `main` is the source of truth.

## Keeping this documentation current

These pages are only useful while they match the code, so a change that alters
backend behaviour must update the matching page **in the same pull request**:

| If you change… | Update… |
| --- | --- |
| the startup sequence, event pipeline/dispatch table, persistence model, logger, or alerting | `architecture.md` |
| any route, request/response shape, or error code | `api-contracts.md` |
| a script, environment variable, Docker/Compose setup, migration flow, or recovery procedure | `runbook.md` |
| a verification assumption in the "Known gaps" lists | the relevant section, by removing or updating the entry |

The same checklist item is part of `CONTRIBUTING.md`. When updating a page, record
the commit you verified against (the current pages were verified at
`2c42735c443e`).
