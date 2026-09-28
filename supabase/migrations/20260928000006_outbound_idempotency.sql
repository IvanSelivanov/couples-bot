-- Идемпотентность исходящих (R13, R27, R29).
--
-- Ключ задаёт вызывающий: для ответа паузы «окно + целевой маркер + часть»,
-- для черновика «draft:<id>». Не аренда: задача, упавшая между отправкой и
-- finish_reply, повторяется уже с новой арендой, и ключ по аренде пропустил
-- бы дубль. Ключ по целевому маркеру ловит его: строка sent говорит «уже
-- отправлено, только заверши».
--
-- Текст сообщения в outbox не хранится (payload всегда null): после
-- неизвестного исхода повтора нет, значит и текст не нужен, а текст лички
-- вне messages запрещает R27. Колонка остаётся nullable на будущее.

alter table outbound add column idempotency_key text;
alter table outbound alter column payload drop not null;
update outbound set idempotency_key = 'legacy:' || id where idempotency_key is null;
alter table outbound alter column idempotency_key set not null;
create unique index outbound_idempotency_key on outbound (idempotency_key);
