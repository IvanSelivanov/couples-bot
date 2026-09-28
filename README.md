# couples-bot

Личный Telegram-бот для пары: ведущий разговора в общей группе, переводчик
между языками партнёров и помощник в личке у каждого. Некоммерческий проект.

Архитектура как у tgbot (Node на Vercel, Gemini, Bot API через fetch) плюс
Supabase для памяти. Дизайн и все решения ревью лежат в
`~/.gstack/projects/tgbot/ivanselivanov-main-design-20260927-140842.md`.

## Требования

- Node 22+
- Docker Desktop (для локального Supabase)

## Первый запуск

```sh
npm install
cp .env.example .env        # заполнить BOT_TOKEN
npm run db:start            # поднимает Postgres + PostgREST в Docker
```

## Тесты

```sh
npm test                    # unit, без сети и базы
npm run test:db             # на локальном Supabase: накатывает миграции с нуля
```

`test:db` требует запущенного `npm run db:start`.

## Спайк Guest Mode

Проверка, от которой зависит дизайн Guest Mode. Нужен отдельный бот.

1. В @BotFather создать бота, токен положить в `.env` как `BOT_TOKEN`.
2. BotFather → MiniApp → настройки бота → включить **Guest Mode**.
3. `npm run spike:guest`
4. В личной переписке с партнёром ответить на его сообщение текстом
   `@имя_бота что он имел в виду?`. Затем повторить с голосовым вместо текста.
5. Ещё раз с долгим ответом: `SPIKE_DELAY_MS=60000 npm run spike:guest`.

Скрипт печатает, что пришло в `guest_message`, и пробует ответить и
отредактировать ответ. Вывод нужно сохранить: по нему решается формат Guest Mode.
