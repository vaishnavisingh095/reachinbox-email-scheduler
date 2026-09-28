import { Client } from "@elastic/elasticsearch";
import { env } from "../config/env";

// Elasticsearch is a derived, read-side search index (ADR-010) — Postgres
// remains the sole source of truth. Nothing in this file, or anything that
// uses this client, is allowed to be on the critical path for sending or
// scheduling an email.
export const esClient = new Client({ node: env.ELASTICSEARCH_URL });
