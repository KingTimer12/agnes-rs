import { test, expect } from "bun:test";
import { table, int, text, float, columnsOf } from "../src/schema";
import {
  SelectBuilder,
  eq, gt, ilike, inArray, notInArray, isNull, isNotNull, between, and, or, not,
  count, sum, avg,
} from "../src/query/builder";
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
