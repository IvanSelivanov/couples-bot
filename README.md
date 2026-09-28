# couples-bot

Личный Telegram-бот для пары: ведущий разговора в общей группе, переводчик
между языками партнёров и помощник в личке у каждого. Некоммерческий проект.

Архитектура как у tgbot (Node на Vercel, Gemini, Bot API через fetch) плюс
Supabase для памяти и Vercel Queues для приёма и дебаунса. Дизайн и все
решения ревью: `~/.gstack/projects/tgbot/ivanselivanov-main-design-20260927-140842.md`.

## Требования

- Node 22+
- Docker Desktop (локальный Supabase)
- Два Google AI Studio ключа: для бота и отдельный для евалов

## Локально

```sh
npm install
cp .env.example .env        # заполнить (см. комментарии в файле)
npm run db:start            # Postgres + PostgREST в Docker
npm run bot                 # long polling, без очереди: дебаунс ждёт сном
```

## Тесты и евалы

```sh
npm test                    # unit, без сети и базы
npm run test:db             # на локальном Supabase, миграции с нуля
npm run eval                # промпты на живой модели, нужен EVAL_GEMINI_API_KEY
```

`npm run eval` — гейт запуска: код выхода 1, если провален любой порог
(в том числе ложные срабатывания абьюза ≤ 2%). Выбрать наборы:
`EVAL_SETS=speak,false_positive npm run eval`.

## Спайк Guest Mode (до запуска)

Проверяет, как Guest Mode работает в личной переписке двоих. От результата
зависит правило «чат подтверждён как личка пары» (`isCoupleChat` в
`lib/handle.js`).

1. BotFather → MiniApp → настройки бота → включить **Guest Mode**.
2. `npm run spike:guest`
3. В личной переписке с партнёром ответить на его сообщение: `@имя_бота что он имел в виду?`.
   Повторить с голосовым вместо текста.
4. `SPIKE_DELAY_MS=60000 npm run spike:guest` — долгий ответ.

Сохранить вывод: `chat_type`, `chat_id`, есть ли `reply_to_message`, работает
ли HTML и редактирование.

## Деплой

1. **Supabase.** Создать проект в регионе **eu-central-1 (Frankfurt)** — рядом с
   функциями Vercel `fra1` (T13). Применить миграции:
   `npx supabase link --project-ref <ref>` и `npx supabase db push`.
2. **Vercel.** Создать проект из этого репо. Регион функций уже задан:
   `"regions": ["fra1"]` в `vercel.json`. Включить Vercel Queues для проекта.
3. **Переменные** в Vercel — все из `.env.example`, кроме `SPIKE_*` и `EVAL_*`.
   `DM_ENCRYPTION_KEY` сохранить ещё где-нибудь вне Vercel: потерянный ключ =
   потерянные лички.
4. **Вебхук и команды:** `npm run setup https://<проект>.vercel.app`.
5. Добавить бота в группу пары, дать права администратора, написать в группе `/start`.

## Ротация ключа шифрования

Старый ключ → `DM_ENCRYPTION_KEY_PREV`, новый → `DM_ENCRYPTION_KEY`,
`DM_ENCRYPTION_KEY_VERSION` + 1. Ежедневный cron перешифрует старые записи;
когда `rewritten` в отчёте cron станет 0, `DM_ENCRYPTION_KEY_PREV` можно убрать.
