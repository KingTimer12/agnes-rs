# agnes-library

Type-safe TypeScript client for **[Agnes](../README.md)** — a database toolkit
with a Rust core and a built-in, self-invalidating query cache. Define your
schema as code, get fully-typed queries and relations, and talk to PostgreSQL,
MySQL, or SQLite through one API.

```bash
bun add agnes-library agnes-bridge
```

> `agnes-bridge` is the native (napi-rs) addon that runs the engine. It's a
> required peer of this package.

---

## Quick start

```ts
import { AgnesClient, table, int, text, bool, many, one, OnAction } from "agnes-library";

export const schema = {
  user: table({
    id:     int("id").primary(),
    name:   text("name").index("name_idx"),
    email:  text("email").uniqueIndex("email_idx"),
    age:    int("age"),
    active: bool("active").default(true),
    posts:  many("post", "userId"),
  }, "users"),
  post: table({
    id:      int("id").primary(),
    userId:  int("user_id"),
    content: text("content"),
    user:    one("user", "userId", "id", OnAction.None, OnAction.Cascade),
  }, "posts"),
};

const db = await AgnesClient.create(
  {
    driver: "sqlite",
    url: "sqlite:./demo.db",
    cache: { enabled: true, walPath: ".agnes/cache.wal" },
  },
  schema,
);
```

> Tip: `agnes generate` (from [`agnes-cli`](../agnes-cli)) writes this
> `AgnesClient.create(...)` module for you from a single config.

---

## Defining a schema

A schema is a `Record` of tables. `table(def, "physical_name")` maps a TS key to
a real table name; each field is a column or a relation.

### Column types

| Helper | TS type | Notes |
|--------|---------|-------|
| `int(name)` | `number` | |
| `bigint(name)` | `bigint` | |
| `text(name)` | `string` | |
| `bool(name)` | `boolean` | |
| `float(name)` | `number` | |
| `bytes(name)` | `Uint8Array` | |
| `json<T>(name)` | `T` | typed JSON column |

### Column modifiers (chainable)

```ts
int("id").primary()                 // PRIMARY KEY
text("bio").nullable()              // NULL allowed → type becomes `string | null`
bool("active").default(true)        // DEFAULT
text("name").index("name_idx")      // non-unique index
text("email").uniqueIndex("uq")     // unique index
```

### Relations

```ts
// This table has many rows of "post" whose `userId` points back here.
posts: many("post", "userId"),

// This table's `userId` references user.id (adds a FK).
user:  one("user", "userId", "id", OnAction.None, OnAction.Cascade),
```

`OnAction`: `None` · `Restrict` · `Cascade` · `SetNull` · `SetDefault` (used for
`ON UPDATE` / `ON DELETE`).

---

## Querying

`columnsOf(schema.user.def)` gives you typed column handles for use in `where`,
`orderBy`, and join conditions.

```ts
import { columnsOf, eq, gt } from "agnes-library";
const u = columnsOf(schema.user.def);
```

### Select

```ts
const adults = await db
  .select("user")
  .where(gt(u.age, 18))
  .orderBy(u.name, "asc")
  .limit(50)
  .ttl(60)          // cache result for 60s
  .all();
```

`.first()` returns one row or `null`. `.bypassCache()` skips the cache for that
query.

#### Choosing columns: `select().from()` and `.omit()`

Two ways to start a select:

```ts
db.select("user")                    // table-first (all columns)

db.select().from("user")             // projection-first — all columns
db.select("name", "email").from("user")  // only these columns
db.select().from("user").omit("password") // everything except password
```

`.omit(...)` saves you from listing every column just to drop one; it's typed
against the table, and the dropped keys disappear from the result type. An empty
`select()` means "all columns"; naming columns keeps only those. Both `.omit()`
column names and the projection are typed from the schema.

### Streaming large results

`.stream(batchSize?)` returns an async iterator that pulls rows in batches
instead of buffering the whole result — for scanning huge tables in constant
memory. The Rust core fetches behind a bounded channel (server-side cursor on
Postgres), so it never materializes all rows at once.

```ts
for await (const user of db.select("user").where(gt(u.age, 18)).stream(1000)) {
  process(user); // one row at a time; memory stays flat over millions of rows
}
```

Not available inside a transaction, and incompatible with `.include()`
(relations need the full set). `.where()`, `.orderBy()` and joins work.

### Relations with `.include()` (no N+1)

```ts
const withPosts = await db
  .select("user")
  .include({ posts: true })
  .all();
// → { ...user, posts: Post[] }[]  — one batched IN query per relation

const postsWithAuthor = await db
  .select("post")
  .include({ user: true })
  .all();
// → { ...post, user: User | null }[]
```

Filter/shape a relation with `query()`:

```ts
import { query } from "agnes-library";

await db.select("user").include({
  posts: query().where(eq(p.published, true)).orderBy(p.createdAt, "desc").limit(5),
}).all();
```

### SQL joins (flat rows)

```ts
import { on } from "agnes-library";
await db.select("user").leftJoin("post", on(u.id, p.userId)).all();
// also: innerJoin / rightJoin / fullJoin
```

### Conditions

Leaves — a column handle and a value:

`eq` · `neq` · `gt` · `gte` · `lt` · `lte` · `like` · `ilike` (case-insensitive) ·
`inArray(col, [...])` · `notInArray(col, [...])` · `isNull(col)` · `isNotNull(col)` ·
`between(col, lo, hi)`.

Combine and nest with `and(...)` / `or(...)` / `not(...)`. `where(a, b)` still
means `a AND b`.

```ts
await db.select("user").where(
  eq(u.active, true),
  or(inArray(u.role, ["admin", "mod"]), isNull(u.role)),
  not(eq(u.age, 0)),
).all();
```

`inArray([])` is always-false and `notInArray([])` always-true — no invalid `IN ()`.

### Aggregations

`count` · `sum` · `avg` · `min` · `max`, with `.groupBy(...)` and `.having(agg, op, value)`.
Terminal `.aggregate({ alias: aggFn, ... })` returns one row per group.

```ts
import { count, sum, avg } from "agnes-library";

const perUser = await db
  .select("order")
  .where(gt(o.total, 0))
  .groupBy(o.userId)
  .having(sum(o.total), ">", 100)
  .aggregate({ spent: sum(o.total), orders: count(), avgTotal: avg(o.total) });
// → { user_id: number; spent: number | null; orders: number | null; avgTotal: number | null }[]
```

`count()` with no argument is `COUNT(*)`. Columns passed to `.groupBy(...)` are
carried into the result type, keyed by their **physical** column name and typed
from the schema (nullable columns become `| null`).

### Insert / update / delete

```ts
await db.insertInto("post").values({ userId: 1, content: "Hello!" });

await db.update("user", { age: 31 }).where(eq(u.id, 5)).run();

await db.deleteFrom("post").where(eq(p.id, 9)).run();
```

**Bulk insert** — pass an array. It goes in one statement, auto-chunked to the
driver's bound-parameter limit (chunks are separate statements — wrap in
`db.transaction` for all-or-nothing). Missing keys insert as `NULL`.

```ts
await db.insertInto("post").values([
  { userId: 1, content: "a" },
  { userId: 2, content: "b" },
]);
```

**Upsert** — `.onConflict(...cols)` with `.merge()` or `.ignore()`:

```ts
// update on conflict (Postgres/SQLite ON CONFLICT, MySQL ON DUPLICATE KEY)
await db.insertInto("user").onConflict(u.id).merge().values({ id: 1, name: "Ana" });

// only update specific columns
await db.insertInto("user").onConflict(u.email).merge(u.name).values({ email: "a@x", name: "Ana" });

// skip on conflict (DO NOTHING / INSERT IGNORE)
await db.insertInto("user").onConflict(u.id).ignore().values({ id: 1, name: "Ana" });
```

`.merge()` with no args updates every inserted column except the conflict
target. MySQL ignores the `onConflict` target and matches on its unique keys.

**Returning rows** — `.returning(...cols)` on insert/update/delete returns the
affected rows instead of a count (Postgres/SQLite `RETURNING`; no args = every
column). Throws on MySQL.

```ts
const [created] = await db.insertInto("user").returning().values({ name: "Ana" });
const updated = await db.update("user", { age: 31 }).where(eq(u.id, 5)).returning(u.id, u.age).run();
const deleted = await db.deleteFrom("post").where(eq(p.id, 9)).returning().run();
```

### Raw SQL

```ts
const rows = await db.query<{ id: number; name: string }>(
  "SELECT id, name FROM users WHERE age > $1",
  [18],
  { ttl: 60 },
);

const affected = await db.mutate("UPDATE users SET active = $1", [false]);
```

---

## Schema push

Create the tables and indexes your schema describes — idempotent, so it's safe
to run on every boot. It emits `CREATE TABLE / INDEX IF NOT EXISTS`, ordered so
foreign-key targets come first. It **only creates what's missing** — it never
alters or drops existing objects (full diff migrations are a separate feature).

```ts
await db.pushSchema();          // create missing tables + indexes
const sql = db.schemaDdl();     // inspect the statements (e.g. for a migration file)
```

Type mapping is per-dialect (`int → SERIAL/INT/INTEGER`, `bool → BOOLEAN/TINYINT(1)/INTEGER`,
`json → JSONB/JSON/TEXT`, …). `.autoincrement()` becomes `SERIAL` (Postgres),
`AUTO_INCREMENT` (MySQL), or `INTEGER PRIMARY KEY AUTOINCREMENT` (SQLite);
`one(...)` relations emit `FOREIGN KEY` constraints with their `ON UPDATE/DELETE`
actions.

---

## Caching

Reads are cached transparently in the Rust core:

- **Automatic** on `SELECT` — set a TTL with `.ttl(secs)` or `query(..., { ttl })`.
- **Content-addressed** keys — a BLAKE3 hash of the normalized SQL + params.
- **Self-invalidating** — every write invalidates the cache tags of the tables it
  touches (parsed from the SQL), so you never read stale data.
- **WAL-backed** — durable across restarts (`walPath`).
- **Opt-out** per query with `.bypassCache()` / `{ bypassCache: true }`.

```ts
type CacheConfig = { enabled: boolean; walPath?: string; compactionThreshold?: number };
```

---

## Transactions

Interactive transactions, Prisma-style. `db.transaction(fn)` runs `fn` against a
`tx` with the same query API (`select`/`insertInto`/`update`/`deleteFrom`/`query`/`mutate`),
all on one connection. It **commits** when `fn` resolves and **rolls back** if it
throws (the error propagates). Reads inside a transaction always hit the DB; the
cache is invalidated once, on commit.

```ts
await db.transaction(async (tx) => {
  await tx.update("account", { balance: 60 }).where(eq(acc.id, 1)).run();
  await tx.update("account", { balance: 40 }).where(eq(acc.id, 2)).run();
  // throw here → both updates roll back
});
```

---

## Configuration

```ts
interface DatabaseConfig {
  driver: "postgres" | "mysql" | "sqlite";
  url: string;
  // Connection pool tuning (all optional):
  maxConnections?: number;    // hard cap on open connections (default 10)
  minConnections?: number;    // connections kept warm while idle (default 0)
  acquireTimeoutSecs?: number; // wait for a free connection before erroring
  idleTimeoutSecs?: number;   // close a connection after this idle time
  maxLifetimeSecs?: number;   // recycle a connection after this lifetime
  cache?: CacheConfig;
  // Read/write splitting (master/slave) — optional:
  replicas?: string[];        // read-only replicas; `url` becomes the write master
  masterReadPenalty?: number; // load penalty on master when picking a reader (default 100)
  replicaCooldownSecs?: number; // skip a replica this long after it errors (default 5)
}
```

Every driver is pooled by default (via `sqlx`). Tune it with the fields above;
omit them for sensible defaults.

### Read/write splitting

Set `replicas` and `url` becomes the write **master**; the listed nodes are
read **replicas**. Writes and transactions go to the master; reads are routed to
the least-loaded node (by live in-flight count). The master also serves reads,
but with a `masterReadPenalty` bias so replicas win while it's under load. A read
that errors cools its node down (`replicaCooldownSecs`) and fails over to the
next-best node.

```ts
const db = await AgnesClient.create({
  driver: "postgres",
  url: "postgres://master/app",
  replicas: ["postgres://replica-1/app", "postgres://replica-2/app"],
}, schema);
```

---

## Type inference helpers

```ts
import type { InferRow, InferInsert } from "agnes-library";

type User = InferRow<typeof schema.user.def>;        // full row type
type NewUser = InferInsert<typeof schema.user.def>;  // partial, for inserts
```

---

## Scripts

```bash
bun run build       # bundle to dist/ + emit .d.ts
bun run typecheck   # tsc --noEmit
bun test            # bun test
```

## Prior art

The query API is **inspired by** [Drizzle](https://orm.drizzle.team) (fluent
builder, `eq`/`gt`-style condition helpers) and [Prisma](https://www.prisma.io)
(typed relations, interactive transactions). The *feel* is deliberately
familiar, but the entire implementation is original work written from scratch —
no source code from those projects is used or derived. "Drizzle" and "Prisma"
are trademarks of their respective owners.

## License

MIT OR Apache-2.0
