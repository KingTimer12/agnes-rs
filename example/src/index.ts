import {
  eq, gt, lt,
  query, on,
} from "agnes-library";
import { seed } from "./seed";
import { schema } from "./schema";
import { db } from "./db";

// ── Seed ──────────────────────────────────────────────────────────────────────

await seed()
console.log("Seeded.\n");

const usersCol = schema.user.toCol();
const postsCol = schema.post.toCol();

// ── include: simple (left — keep parent even if no children) ─────────────────

console.log("=== include { posts: true } — all adults with posts array ===");
const adultsWithPosts = await db
  .select("user")
  .where(gt(usersCol.age, 18))
  .include({ posts: true })
  .ttl(60)
  .all();
console.log(JSON.stringify(adultsWithPosts, null, 2));

// ── include: query() with where + orderBy + limit ────────────────────────────

console.log("\n=== include posts — only first 2 posts, ordered by id desc ===");
const usersLimitedPosts = await db
  .select("user")
  .where(gt(usersCol.age, 18))
  .include({
    posts: query()
      .orderBy(postsCol.id, "desc")
      .limit(2),
  })
  .all();
console.log(JSON.stringify(usersLimitedPosts, null, 2));

// ── include: query() with type("inner") — drop parents with no children ──────

console.log("\n=== include posts type(inner) — only users who have posts ===");
const usersWithAnyPost = await db
  .select("user")
  .include({
    posts: query().type("inner"),
  })
  .all();
console.log(JSON.stringify(usersWithAnyPost, null, 2));

// ── include: query() with extra where + select specific columns ───────────────

console.log("\n=== include posts — where id < 3, select only id + title ===");
const usersFilteredPostCols = await db
  .select("user")
  .include({
    posts: query()
      .where(lt(postsCol.id, 3))
      .select(postsCol.id, postsCol.title),
  })
  .all();
console.log(JSON.stringify(usersFilteredPostCols, null, 2));

// ── include one: post → user (type inner = drop posts with no user) ───────────

console.log("\n=== posts include { user } — each post with its author ===");
const postsWithUser = await db
  .select("post")
  .include({ user: true })
  .all();
console.log(JSON.stringify(postsWithUser, null, 2));

// ── SQL LEFT JOIN: flat rows, single query ────────────────────────────────────

console.log("\n=== LEFT JOIN posts ON users.id = posts.user_id (flat rows) ===");
const flatJoined = await db
  .select("user")
  .leftJoin("post", on(usersCol.id, postsCol.userId))
  .where(gt(usersCol.age, 18))
  .orderBy(usersCol.id)
  .all();
console.log(JSON.stringify(flatJoined, null, 2));

// ── SQL INNER JOIN: only rows with matching post ──────────────────────────────

console.log("\n=== INNER JOIN posts ON users.id = posts.user_id ===");
const innerJoined = await db
  .select("user")
  .innerJoin("post", on(usersCol.id, postsCol.userId))
  .all();
console.log(JSON.stringify(innerJoined, null, 2));

// ── Update + delete ───────────────────────────────────────────────────────────

await db.update("user", { active: false }).where(eq(usersCol.id, 2)).run();
await db.deleteFrom("post").where(eq(postsCol.userId, 3)).run();

console.log("\nDone.");
