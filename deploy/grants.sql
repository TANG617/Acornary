-- Run as the migration role after each migration. Runtime cannot run DDL,
-- alter owner mappings, mutate history, or update template definitions.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO acornary_app;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO acornary_app;
GRANT INSERT,UPDATE,DELETE ON catalog_nodes,items,notes,barcode_index,operations TO acornary_app;
GRANT INSERT ON events TO acornary_app;
GRANT INSERT,UPDATE,DELETE ON "user",session,account,verification,jwks,"oauthClient","oauthResource","oauthClientResource","oauthRefreshToken","oauthAccessToken","oauthConsent","oauthClientAssertion","rateLimit" TO acornary_app;
