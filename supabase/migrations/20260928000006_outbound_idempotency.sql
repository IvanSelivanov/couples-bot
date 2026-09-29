-- Idempotency of outgoing messages (R13, R27, R29).
--
-- The caller sets the key: for a pause reply "window + target marker + part",
-- for a draft "draft:<id>". Not the lease: a task that died between sending and
-- finish_reply is retried with a new lease, and a lease-based key would let a
-- duplicate through. A key on the target marker catches it: a sent row says
-- "already sent, just finish".
--
-- The message text isn't stored in the outbox (payload is always null): there's no
-- retry after an unknown outcome, so the text isn't needed, and private chat text
-- outside messages is forbidden by R27. The column stays nullable for the future.

alter table outbound add column idempotency_key text;
alter table outbound alter column payload drop not null;
update outbound set idempotency_key = 'legacy:' || id where idempotency_key is null;
alter table outbound alter column idempotency_key set not null;
create unique index outbound_idempotency_key on outbound (idempotency_key);
