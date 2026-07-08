import { test, expect } from "bun:test";
import { table, int, text, float, columnsOf } from "../src/schema";
import {
  SelectBuilder,
  InsertBuilder,
  UpdateBuilder,
  DeleteBuilder,
} from "../src/query/builders";
import {
  eq, gt, ilike, inArray, notInArray, isNull, isNotNull, between, and, or, not,
} from "../src/query/conditions";
import { count, sum, avg } from "../src/query/aggregate";
import type { QueryRunner } from "../src/bridge";

const orderTbl = table(
  {
    id: int("id").primary(),
    userId: int("user_id"),
    total: float("total"),
    status: text("status"),
    note: text("note").nullable(),
  },
  "orders",
);
const o = columnsOf(orderTbl.def);
const schema = { order: orderTbl };

// Capture the SQL/params a terminal method would send, without a real DB.
function capture(): { runner: QueryRunner; calls: { sql: string; params: unknown[] }[] } {
  const calls: { sql: string; params: unknown[] }[] = [];
  const runner: QueryRunner = {
    async query(sql, params) {
      calls.push({ sql, params: params ?? [] });
      return [];
    },
    async mutate() {
      return 0;
    },
  };
  return { runner, calls };
}

function sb() {
  const { runner, calls } = capture();
  const b = new SelectBuilder(runner, "orders", orderTbl.def, "postgres", schema);
  return { b, calls };
}

test("build() with plain AND conds keeps old behavior", () => {
  const b = new SelectBuilder(capture().runner, "orders", orderTbl.def, "postgres", schema);
  const { sql, params } = b.where(eq(o.status, "paid"), gt(o.total, 10)).build();
  expect(sql).toBe(`SELECT * FROM "orders" WHERE "status" = $1 AND "total" > $2`);
  expect(params).toEqual(["paid", 10]);
});

test("inArray / notInArray", () => {
  const a = new SelectBuilder(capture().runner, "orders", orderTbl.def, "postgres", schema)
    .where(inArray(o.id, [1, 2, 3]))
    .build();
  expect(a.sql).toBe(`SELECT * FROM "orders" WHERE "id" IN ($1, $2, $3)`);
  expect(a.params).toEqual([1, 2, 3]);

  const empty = new SelectBuilder(capture().runner, "orders", orderTbl.def, "postgres", schema)
    .where(inArray(o.id, []))
    .build();
  expect(empty.sql).toBe(`SELECT * FROM "orders" WHERE 1 = 0`);

  const emptyNot = new SelectBuilder(capture().runner, "orders", orderTbl.def, "postgres", schema)
    .where(notInArray(o.id, []))
    .build();
  expect(emptyNot.sql).toBe(`SELECT * FROM "orders" WHERE 1 = 1`);
});

test("null / between / ilike", () => {
  const n = new SelectBuilder(capture().runner, "orders", orderTbl.def, "postgres", schema)
    .where(isNull(o.note), isNotNull(o.status))
    .build();
  expect(n.sql).toBe(`SELECT * FROM "orders" WHERE "note" IS NULL AND "status" IS NOT NULL`);

  const bt = new SelectBuilder(capture().runner, "orders", orderTbl.def, "postgres", schema)
    .where(between(o.total, 5, 50))
    .build();
  expect(bt.sql).toBe(`SELECT * FROM "orders" WHERE "total" BETWEEN $1 AND $2`);
  expect(bt.params).toEqual([5, 50]);

  const pg = new SelectBuilder(capture().runner, "orders", orderTbl.def, "postgres", schema)
    .where(ilike(o.status, "%pa%"))
    .build();
  expect(pg.sql).toBe(`SELECT * FROM "orders" WHERE "status" ILIKE $1`);

  const my = new SelectBuilder(capture().runner, "orders", orderTbl.def, "mysql", schema)
    .where(ilike(o.status, "%pa%"))
    .build();
  expect(my.sql).toBe("SELECT * FROM `orders` WHERE LOWER(`status`) LIKE LOWER(?)");
});

test("nested and/or/not with correct parens and param order", () => {
  const { sql, params } = new SelectBuilder(capture().runner, "orders", orderTbl.def, "postgres", schema)
    .where(eq(o.userId, 7), or(inArray(o.status, ["a", "b"]), isNull(o.status)), not(eq(o.total, 0)))
    .build();
  expect(sql).toBe(
    `SELECT * FROM "orders" WHERE "user_id" = $1 AND ("status" IN ($2, $3) OR "status" IS NULL) AND NOT ("total" = $4)`,
  );
  expect(params).toEqual([7, "a", "b", 0]);
});

test("select().from() selects all columns (star)", () => {
  const b = new SelectBuilder(capture().runner, "orders", orderTbl.def, "postgres", schema);
  expect(b.build().sql).toBe(`SELECT * FROM "orders"`);
});

test("select(fields).from() projects only those columns (physical names)", () => {
  const b = new SelectBuilder(capture().runner, "orders", orderTbl.def, "postgres", schema, ["id", "userId"]);
  expect(b.build().sql).toBe(`SELECT "id", "user_id" FROM "orders"`);
});

test("omit() selects all columns except the omitted ones", () => {
  const b = new SelectBuilder(capture().runner, "orders", orderTbl.def, "postgres", schema)
    .omit("note", "status");
  expect(b.build().sql).toBe(`SELECT "id", "user_id", "total" FROM "orders"`);
});

test("omit result type drops the key (compile-time)", async () => {
  const runner: QueryRunner = {
    async query() {
      return [{ id: 1, user_id: 2, total: 9 }];
    },
    async mutate() {
      return 0;
    },
  };
  const rows = await new SelectBuilder(runner, "orders", orderTbl.def, "postgres", schema)
    .omit("note")
    .all();
  const row = rows[0]!;
  // @ts-expect-error `note` was omitted from the row type
  void row.note;
  expect(row.id).toBe(1);
});

test("count() builds COUNT(*) and coerces the result", async () => {
  const { runner, calls } = (() => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const runner: QueryRunner = {
      async query(sql, params) {
        calls.push({ sql, params: params ?? [] });
        return [{ n: "42" }];
      },
      async mutate() {
        return 0;
      },
    };
    return { runner, calls };
  })();
  const n = await new SelectBuilder(runner, "orders", orderTbl.def, "postgres", schema)
    .where(gt(o.total, 0))
    .count();
  expect(calls[0]!.sql).toBe(`SELECT COUNT(*) AS "n" FROM "orders" WHERE "total" > $1`);
  expect(n).toBe(42);
});

test("exists() builds SELECT 1 LIMIT 1 and returns bool", async () => {
  const empty: QueryRunner = { async query() { return []; }, async mutate() { return 0; } };
  const some: QueryRunner = { async query() { return [{ "1": 1 }]; }, async mutate() { return 0; } };
  const b = (r: QueryRunner) => new SelectBuilder(r, "orders", orderTbl.def, "postgres", schema).where(eq(o.id, 1));
  expect(await b(empty).exists()).toBe(false);
  expect(await b(some).exists()).toBe(true);
});

test("limit + offset and page()", () => {
  const lo = new SelectBuilder(capture().runner, "orders", orderTbl.def, "postgres", schema)
    .orderBy(o.id)
    .limit(10)
    .offset(20)
    .build();
  expect(lo.sql).toBe(`SELECT * FROM "orders" ORDER BY "id" ASC LIMIT 10 OFFSET 20`);

  const pg = new SelectBuilder(capture().runner, "orders", orderTbl.def, "postgres", schema)
    .page(3, 20)
    .build();
  expect(pg.sql).toBe(`SELECT * FROM "orders" LIMIT 20 OFFSET 40`);
});

test("offset without limit uses dialect fallback", () => {
  const pg = new SelectBuilder(capture().runner, "orders", orderTbl.def, "postgres", schema).offset(5).build();
  expect(pg.sql).toBe(`SELECT * FROM "orders" OFFSET 5`);

  const sq = new SelectBuilder(capture().runner, "orders", orderTbl.def, "sqlite", schema).offset(5).build();
  expect(sq.sql).toBe(`SELECT * FROM "orders" LIMIT -1 OFFSET 5`);

  const my = new SelectBuilder(capture().runner, "orders", orderTbl.def, "mysql", schema).offset(5).build();
  expect(my.sql).toBe("SELECT * FROM `orders` LIMIT 18446744073709551615 OFFSET 5");
});

test("aggregate with groupBy + having", async () => {
  const { b, calls } = sb();
  await b
    .where(gt(o.total, 0))
    .groupBy(o.userId)
    .having(sum(o.total), ">", 100)
    .aggregate({ spent: sum(o.total), n: count(), avgTotal: avg(o.total) });
  expect(calls).toHaveLength(1);
  const call = calls[0]!;
  expect(call.sql).toBe(
    `SELECT "user_id", SUM("total") AS "spent", COUNT(*) AS "n", AVG("total") AS "avgTotal" ` +
      `FROM "orders" WHERE "total" > $1 GROUP BY "user_id" HAVING SUM("total") > $2`,
  );
  expect(call.params).toEqual([0, 100]);
});

test("aggregate result types grouped columns by physical name", async () => {
  const runner: QueryRunner = {
    async query() {
      return [{ user_id: 7, spent: 42 }];
    },
    async mutate() {
      return 0;
    },
  };
  const rows = await new SelectBuilder(runner, "orders", orderTbl.def, "postgres", schema)
    .groupBy(o.userId)
    .aggregate({ spent: sum(o.total) });
  // Compile-time: `user_id` is typed as number, `spent` as number | null.
  const uid: number = rows[0]!.user_id;
  const spent: number | null = rows[0]!.spent;
  expect(uid).toBe(7);
  expect(spent).toBe(42);
});

// ─── InsertBuilder ────────────────────────────────────────────────────────────

function mutCapture() {
  const calls: { sql: string; params: unknown[] }[] = [];
  const runner: QueryRunner = {
    async query() {
      return [];
    },
    async mutate(sql, params) {
      calls.push({ sql, params: params ?? [] });
      return 1;
    },
  };
  return { runner, calls };
}

test("single-row insert (backward compatible)", async () => {
  const { runner, calls } = mutCapture();
  const n = await new InsertBuilder(runner, "orders", orderTbl.def, "postgres").values({
    userId: 1,
    total: 9,
  });
  expect(n).toBe(1);
  expect(calls[0]!.sql).toBe(
    `INSERT INTO "orders" ("user_id", "total") VALUES ($1, $2)`,
  );
  expect(calls[0]!.params).toEqual([1, 9]);
});

test("multi-row insert, union of keys fills missing with NULL", async () => {
  const { runner, calls } = mutCapture();
  await new InsertBuilder(runner, "orders", orderTbl.def, "postgres").values([
    { userId: 1, total: 9 },
    { userId: 2, status: "new" },
  ]);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.sql).toBe(
    `INSERT INTO "orders" ("user_id", "total", "status") VALUES ($1, $2, $3), ($4, $5, $6)`,
  );
  expect(calls[0]!.params).toEqual([1, 9, null, 2, null, "new"]);
});

test("upsert merge (postgres) updates non-conflict cols by default", async () => {
  const { runner, calls } = mutCapture();
  await new InsertBuilder(runner, "orders", orderTbl.def, "postgres")
    .onConflict(o.id)
    .merge()
    .values({ id: 5, total: 3, status: "paid" });
  expect(calls[0]!.sql).toBe(
    `INSERT INTO "orders" ("id", "total", "status") VALUES ($1, $2, $3) ` +
      `ON CONFLICT ("id") DO UPDATE SET "total" = EXCLUDED."total", "status" = EXCLUDED."status"`,
  );
});

test("upsert ignore (sqlite) and mysql prefix", async () => {
  const pg = mutCapture();
  await new InsertBuilder(pg.runner, "orders", orderTbl.def, "sqlite")
    .onConflict(o.id)
    .ignore()
    .values({ id: 5, total: 3 });
  expect(pg.calls[0]!.sql).toBe(
    `INSERT INTO "orders" ("id", "total") VALUES (?, ?) ON CONFLICT ("id") DO NOTHING`,
  );

  const my = mutCapture();
  await new InsertBuilder(my.runner, "orders", orderTbl.def, "mysql")
    .ignore()
    .values({ id: 5, total: 3 });
  expect(my.calls[0]!.sql).toBe(
    "INSERT IGNORE INTO `orders` (`id`, `total`) VALUES (?, ?)",
  );

  const myMerge = mutCapture();
  await new InsertBuilder(myMerge.runner, "orders", orderTbl.def, "mysql")
    .onConflict(o.id)
    .merge(o.total)
    .values({ id: 5, total: 3 });
  expect(myMerge.calls[0]!.sql).toBe(
    "INSERT INTO `orders` (`id`, `total`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `total` = VALUES(`total`)",
  );
});

// ─── RETURNING ────────────────────────────────────────────────────────────────

function returningCapture() {
  const calls: { sql: string; params: unknown[] }[] = [];
  const runner: QueryRunner = {
    async query(sql, params) {
      calls.push({ sql, params: params ?? [] });
      return [{ id: 1, total: 9 }];
    },
    async mutate() {
      return 1;
    },
  };
  return { runner, calls };
}

test("insert .returning() runs a query with RETURNING and yields rows", async () => {
  const { runner, calls } = returningCapture();
  const rows = await new InsertBuilder(runner, "orders", orderTbl.def, "postgres")
    .returning()
    .values({ userId: 1, total: 9 });
  expect(calls[0]!.sql).toBe(
    `INSERT INTO "orders" ("user_id", "total") VALUES ($1, $2) RETURNING *`,
  );
  expect(rows).toEqual([{ id: 1, total: 9 }] as unknown as typeof rows);
});

test("update/delete .returning(cols) selects those columns", async () => {
  const u = returningCapture();
  await new UpdateBuilder(u.runner, "orders", orderTbl.def, { status: "paid" }, "postgres")
    .where(eq(o.id, 1))
    .returning(o.id, o.total)
    .run();
  expect(u.calls[0]!.sql).toBe(
    `UPDATE "orders" SET "status" = $1 WHERE "id" = $2 RETURNING "id", "total"`,
  );

  const d = returningCapture();
  await new DeleteBuilder(d.runner, "orders", orderTbl.def, "postgres")
    .where(eq(o.id, 1))
    .returning()
    .run();
  expect(d.calls[0]!.sql).toBe(`DELETE FROM "orders" WHERE "id" = $1 RETURNING *`);
});

test("returning throws on mysql", async () => {
  await expect(
    new DeleteBuilder(returningCapture().runner, "orders", orderTbl.def, "mysql")
      .returning()
      .run(),
  ).rejects.toThrow(/not supported on MySQL/);
});

// ─── streaming ──────────────────────────────────────────────────────────────

test("stream() pulls batches until empty and yields each row", async () => {
  const pages = [[{ id: 1 }, { id: 2 }], [{ id: 3 }], []];
  let call = 0;
  const runner: QueryRunner = {
    async query() {
      return [];
    },
    async mutate() {
      return 0;
    },
    async stream() {
      return { async nextBatch() { return pages[call++]; } };
    },
  };
  const b = new SelectBuilder(runner, "orders", orderTbl.def, "postgres", schema);
  const got: unknown[] = [];
  for await (const row of b.stream(2)) got.push(row);
  expect(got).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
});

test("stream() rejects inside a transaction (no stream on runner)", async () => {
  const runner: QueryRunner = { async query() { return []; }, async mutate() { return 0; } };
  const b = new SelectBuilder(runner, "orders", orderTbl.def, "postgres", schema);
  await expect(async () => {
    for await (const _ of b.stream()) void _;
  }).toThrow(/only available on the database/);
});

test("bulk insert chunks by param limit (sqlite)", async () => {
  const { runner, calls } = mutCapture();
  // sqlite cap 900 vars / 1 col = 900 rows per chunk.
  const rows = Array.from({ length: 950 }, (_, i) => ({ userId: i }));
  const n = await new InsertBuilder(runner, "orders", orderTbl.def, "sqlite").values(rows);
  expect(calls).toHaveLength(2);
  expect(n).toBe(2); // one affected per mutate() stub call
});
