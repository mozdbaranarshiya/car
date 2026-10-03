-- Isolated CI PostgreSQL, not a production migration.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
