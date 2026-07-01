import { db } from "./db";

export const seed = async () => {
  await db.deleteFrom("user").run()
  await db.deleteFrom("post").run()

  await db.insertInto("user").values({ id: 1, name: "Alice",   email: "alice@example.com",   age: 30, active: true });
  await db.insertInto("user").values({ id: 2, name: "Bob",     email: "bob@example.com",     age: 17, active: true });
  await db.insertInto("user").values({ id: 3, name: "Charlie", email: "charlie@example.com", age: 25, active: false });

  await db.insertInto("post").values({ userId: 1, title: "Hello World",    body: "First post by Alice." });
  await db.insertInto("post").values({ userId: 1, title: "Agnes is fast",  body: "Built on Rust + sqlx." });
  await db.insertInto("post").values({ userId: 1, title: "Third post",     body: "Alice writes a lot." });
  await db.insertInto("post").values({ userId: 3, title: "Charlie's take", body: "Inactive user, active posts." });
}
