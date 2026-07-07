import { test, expect } from "bun:test";
import { table, int, text, bool, one, OnAction, type Schema } from "../src/schema";
import { generateSchemaDdl, createTableSql } from "../src/query/ddl";

const schema = {
  user: table(
    {
      id: int("id").primary().autoincrement(),
      email: text("email").uniqueIndex("user_email_idx"),
      active: bool("active").default(true),
      bio: text("bio").nullable(),
    },
    "users",
  ),
  post: table(
    {
      id: int("id").primary().autoincrement(),
      userId: int("user_id").index("post_user_idx"),
      title: text("title"),
      user: one("user", "userId", "id", OnAction.None, OnAction.Cascade),
    },
    "posts",
  ),
} satisfies Schema;

test("createTableSql — postgres: serial pk, not null, default, no fk", () => {
  expect(createTableSql("postgres", schema.user, schema)).toBe(
    `CREATE TABLE IF NOT EXISTS "users" (` +
      `"id" SERIAL, "email" TEXT NOT NULL, "active" BOOLEAN NOT NULL DEFAULT TRUE, "bio" TEXT, ` +
      `PRIMARY KEY ("id"))`,
  );
});

test("createTableSql — postgres: foreign key with actions", () => {
  expect(createTableSql("postgres", schema.post, schema)).toBe(
    `CREATE TABLE IF NOT EXISTS "posts" (` +
      `"id" SERIAL, "user_id" INTEGER NOT NULL, "title" TEXT NOT NULL, ` +
      `PRIMARY KEY ("id"), ` +
      `FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE CASCADE)`,
  );
});

test("sqlite autoincrement pk is inline INTEGER PRIMARY KEY AUTOINCREMENT", () => {
  const sql = createTableSql("sqlite", schema.user, schema);
  expect(sql).toContain(`"id" INTEGER PRIMARY KEY AUTOINCREMENT`);
  expect(sql).not.toContain("PRIMARY KEY (");
  expect(sql).toContain(`"active" INTEGER NOT NULL DEFAULT 1`);
});

test("mysql: auto_increment + backtick idents", () => {
  const sql = createTableSql("mysql", schema.user, schema);
  expect(sql).toContain("`id` INT AUTO_INCREMENT");
  expect(sql).toContain("`active` TINYINT(1) NOT NULL DEFAULT 1");
  expect(sql).toContain("PRIMARY KEY (`id`)");
});

test("generateSchemaDdl — deps first, then indexes", () => {
  const stmts = generateSchemaDdl("postgres", schema);
  // user (FK target) before post.
  const userIdx = stmts.findIndex((s) => s.includes(`TABLE IF NOT EXISTS "users"`));
  const postIdx = stmts.findIndex((s) => s.includes(`TABLE IF NOT EXISTS "posts"`));
  expect(userIdx).toBeGreaterThanOrEqual(0);
  expect(userIdx).toBeLessThan(postIdx);
  // indexes come after all tables.
  const firstIndex = stmts.findIndex((s) => s.startsWith("CREATE UNIQUE INDEX") || s.startsWith("CREATE INDEX"));
  expect(firstIndex).toBeGreaterThan(postIdx);
  expect(stmts).toContain(
    `CREATE UNIQUE INDEX IF NOT EXISTS "user_email_idx" ON "users" ("email")`,
  );
  expect(stmts).toContain(
    `CREATE INDEX IF NOT EXISTS "post_user_idx" ON "posts" ("user_id")`,
  );
});
