// Opens a database connection via agnes-library's AgnesClient (Rust bridge)
// and exposes the query/mutate surface the CLI needs.
import { AgnesClient } from "agnes-library";
import type { AgnesConfig } from "./config";
import type { QueryClient } from "./introspect";

export interface CliDb extends QueryClient {
  mutate(sql: string, params?: unknown[]): Promise<number>;
}

export async function openDb(config: AgnesConfig): Promise<CliDb> {
  const client = await AgnesClient.create(
    {
      driver: config.driver,
      url: config.url,
      maxConnections: config.maxConnections,
    },
    config.schema as never,
  );

  return {
    query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
      client.query<T>(sql, params, { bypassCache: true }),
    mutate: (sql: string, params?: unknown[]) => client.mutate(sql, params),
  };
}
