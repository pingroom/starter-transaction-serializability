# PingRoom transaction serializability

Review a small exported operation trace with its owner, then check whether its declared accesses are conflict-equivalent to a serial transaction order. PingRoom collects the meaning of custom operations; application code produces an equivalent order or a concrete conflict cycle.

Use this beside an importer or debugging tool that already exports a complete trace. It connects to no database, executes no SQL, aborts no transactions and changes no isolation settings.

## Try it offline

Use Node.js 22 or newer and private persistent storage on macOS or Linux. Choose **Use this template**, clone your repository, then run:

```sh
npm ci
npm test
npm run demo
```

The demos cover an acyclic trace, a conflicting cycle and an Unknown classification. They use published `@pingroom/sdk` **0.8.0** with an in-memory transport. Tests and demos need no credentials or network after installation. Dependencies are locked; `.npmrc` requests a 14-day minimum release age where supported by npm.

## Prepare and connect

```sh
cp examples/trace.json trace.json
cp config.example.json config.json
npm run validate
npm run connect
npm run inspect
```

Install [PingRoom](https://pingroom.io/i), approve the printed pairing link, and select a **standard private room** containing the trace owner. Grant room-read and question-ask access plus that room grant. Verify the person in the app, then copy their exact member UUID from `inspect` into `config.json`. Names alone do not establish identity.

Pairing saves private `.pingroom/credentials.json`. Alternatively, copy `.env.example` to `.env` and set **both** `PINGROOM_TOKEN` and `PINGROOM_ROOM`, or supply both in the process environment. Blank or partial pairs fail without borrowing saved credentials. Retain the original asking registration for later Question reads.

Adapt `trace.json` before starting:

| Field | Contents |
| --- | --- |
| `traceId`, `title`, `purpose` | Identify the snapshot and explain the access-classification task. |
| `transactions` | One to four `{id, label}` declarations. |
| `objects` | One to four `{id, label}` declarations of exact logical objects. |
| `events` | One to eight ordered `{id, transactionId, objectId, description}` entries. |

The event array defines the total operation order; do not sort it by ID. Each declaration must appear in at least one event. Duplicate IDs, unknown references, extra properties and malformed text are rejected. Transaction/object declaration order is canonicalized; event order remains fixed.

Supply a **complete single-version trace of completed, committed transactions**, with every modeled access represented and each event referring to one logical object. Completeness and object identity are not independently verified. Each event is one indivisible modeled access; split a non-atomic read-modify-write into its actual read/write events. Split multi-object operations only when access order is known. Predicate/range reads, multiversion behavior, rollbacks, commit ordering and external effects are outside the model.

## Classify operations

```sh
npm start
```

Each invocation creates at most one Question or reads the active Question once. Answer on the phone, run again to record it, then run again to ask the next event. Each prompt includes the trace purpose, event description, transaction and object:

- **ReadOnly**: reads this object without writing it.
- **Writes**: writes this object, including read-modify-write.
- **NoAccess**: neither reads nor writes this object.
- **Unknown**: the access cannot be established.

Keep descriptions and labels non-sensitive: they are sent to PingRoom along with source/policy hashes. No credentials or database values are needed in the manifest.

There are at most eight Questions, each lasting 15 minutes. There is no background Question polling, automatic reissue or POST retry. Unknown, missing, cancelled, expired, invalid or uncertain-creation evidence withholds the whole analysis. Later events can still be classified after terminal failures. NoAccess events remain in the evidence.

## Read the analysis

```sh
npm run status
npm run report
npm run export
```

These commands read local evidence. `report` writes `.analysis/report.json`; `export` writes `.analysis/analysis.json` after every event has a known answer. **Both acyclic and cyclic analyses are complete and exportable.** Refused exports preserve existing files. All paths resolve from the project directory.

For each earlier/later pair, code adds a precedence edge when the events belong to different transactions, access the same object, neither is NoAccess, and at least one Writes. Every edge retains its actual event-pair witnesses, object, access types and zero-based source indices.

The result contains:

- `conflictSerializable`, the transaction list, classified events and all conflict edges.
- For an acyclic graph, `serialOrder` and `serialEventOrder`. Ties use ASCII transaction-ID order; events within a transaction retain source order. Transactions with only NoAccess events are included.
- For a cyclic graph, null serial orders and a simple closed cycle with an actual event-pair witness for every edge.

The export also preserves the source manifest, hashes, policy version and attributed Question receipts. [Berkeley](https://dsf.berkeley.edu/topics/lecs/dbprimer/tsld060.htm) and [CMU's concurrency lecture](https://15415.courses.cs.cmu.edu/fall2015/slides/21CC1.pdf) describe the acyclic precedence-graph criterion. This independently implemented analysis checks **conflict serializability**, not broader view serializability. A cycle does not establish deadlock, failed recovery or an actual database isolation violation. A positive result does not validate omitted operations or the owner's classifications.

Import `step` from `src/engine.js` into a serialized runner or read the JSON in your trace viewer. `analyzeTrace` in `src/model.js` is a pure local helper. Keep classification rules and later actions in application code; no SQL runner or remediation handler is supplied.

## Resume and recover

Keep the manifest, owner configuration, original connection and `.analysis/`. Changed event order, descriptions, object identities or connection cannot reuse saved answers. Declaration-array reordering can resume.

Creation intent is saved before the POST. A lost response leaves `create_unknown` and blocks replacement Questions:

```sh
npm run find-id
npm run recover -- QUESTION_UUID
```

Recovery validates the original request, room, target, asker, answer and lifetime. An empty recent search does not prove creation failed. Inspect the original registration's history and retain uncertain state; reconnecting does not grant access to old Questions.

Pending pairing reuses its retained bearer and session link. For uncertain or expired pairing, inspect Connected Agents and resolve or revoke any created registration before archiving `.pingroom/pairing.json` for deliberate new setup.

Writes use private files, atomic rename, sync and a lock. After a crash, inspect `.analysis/.lock/owner.json` or `.pingroom/.lock/owner.json`; remove only a stale lock after confirming the process stopped. Restore corrupt state from backup. Local evidence is not tamper-proof. Credentials, real inputs, state and exports are ignored by Git.

## Limits and checks

Trace IDs allow 40 lowercase slug characters; other IDs allow 16. Title/purpose/declaration-label/event-description limits are 40/60/24/60 UTF-16 units. Text must be trimmed, single-line, well-formed Unicode without control/format characters or line separators. Input/configuration caps are 64/16 KiB; state/output caps are 1 MiB. HTTP bodies are capped at 512 KiB with a five-second deadline and no redirects.

The November 12, 2026 contract check confirms the pinned SDK's ordinary first-answer Questions. Optional absent/null results and absent/false handoff flags are accepted; poll tallies and changed request provenance are rejected.

Run/recovery exit codes: `0` complete, including a cycle finding; `2` incomplete or newly failed evidence; `3` ready/pending/interrupted; `4` uncertain creation; `1` error. Successful local commands return `0`; refused export returns `1`.

GitHub Actions runs installation, tests and demos on Node 22 and 24. Tests independently enumerate serial event sequences for 29,181 small trace/classification cases, validate cycle witnesses, and exercise storage, recovery, pairing and CLI subprocesses with mocks. Live phone delivery is not tested.

MIT licensed. See [LICENSE](LICENSE).
