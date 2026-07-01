import {
  AgnesClient,
  int, text, bool,
  many, one, OnAction, table,
  eq, gt,
  columnsOf,
} from "./src";

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
    driver: "postgres",
    url: "postgres://user:pass@localhost/db",
    cache: { enabled: true, walPath: ".agnes/cache.wal" },
  },
  schema,
);

const usersCol = columnsOf(schema.user.def);

// Select with include — posts nested as array
const adults = await db
  .select("user")
  .where(gt(usersCol.age, 18))
  .include({ posts: true })
  .ttl(60)
  .all();
// typed: { id: number; name: string; ...; posts: { id: number; user_id: number; content: string }[] }[]

console.log(adults);

// Select posts with user — user nested as object | null
const postsCol = columnsOf(schema.post.def);
const posts = await db
  .select("post")
  .include({ user: true })
  .all();
// typed: { id: number; user_id: number; content: string; user: { id: number; name: string; ... } | null }[]

console.log(posts);

await db
  .update("user", { age: 17 })
  .where(eq(usersCol.id, 5))
  .run();

await db.insertInto("post").values({ userId: 1, content: "Hello!" });

const raw = await db.query<{ id: number; name: string }>(
  "SELECT id, name FROM users WHERE age > $1",
  [18],
  { ttl: 60 },
);
console.log(raw);
