import { bool, int, many, OnAction, one, table, text } from "agnes-library";

export const schema = {
  user: table({
    id:     int("id").primary(),
    name:   text("name").index("users_name_idx"),
    email:  text("email").uniqueIndex("users_email_idx"),
    age:    int("age"),
    active: bool("active").default(true),
    posts:  many("post", "userId"),
  }, "users"),
  post: table({
    id:     int("id").primary(),
    userId: int("user_id"),
    title:  text("title"),
    body:   text("body"),
    user:   one("user", "userId", "id", OnAction.None, OnAction.Cascade),
  }, "posts"),
};
