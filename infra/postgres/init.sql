CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Separate schema for LangGraph checkpoints (auto-managed by PostgresSaver)
CREATE SCHEMA IF NOT EXISTS langgraph;
GRANT ALL ON SCHEMA langgraph TO reunion;
