# couples-bot

A Telegram bot for one couple: a calm conversation helper in the couple's
shared group, a translator between the partners' languages, and a private
assistant for each partner. It is a non-commercial side project. Everyone
deploys their own copy: one deployment serves one couple, and the person who
deploys it controls the data.

It is not a therapist and does not pretend to be one.

## What it does

**In the couple's group**
- Translates messages between the partners' languages (meaning and tone, not
  word by word). `/translate` switches it on and off.
- Waits for a pause in the conversation and speaks only when there is tension,
  a misunderstanding or a question addressed to it. Never takes sides. Answers
  are short, with one question at most.
- Transcribes voice messages and video notes and translates them for the
  partner.
- Offers an understanding check: each partner restates what they heard.
- When a conversation window closes, it posts a short recap: what got
  clarified and what is still open.
- `/pause` silences the bot.

**In a private chat with each partner**
- A private helper that knows the shared context.
- `/draft` helps phrase a message to your partner before you send it.
- `/notes`: things you want the bot to keep in mind. A note is only used in
  the shared conversation if you allow it, and it is never quoted verbatim.
- Data controls in `/menu`: delete your chat, delete the shared history,
  withdraw consent.

**In the couple's own 1:1 chat (Telegram Guest Mode)**
- Reply to a partner's message (text, voice or video note) with
  `@your_bot what did they mean?` and the bot explains it in both languages,
  with hypotheses rather than verdicts. In any other chat it only rephrases,
  in your language, and stores nothing.

**Safety**
- If a message looks like a crisis (a threat to hurt someone, self-harm), the
  bot does not ask the model anything. It sends a static message with help
  lines for each partner's country. The numbers are fetched in advance and
  verified against their source pages.
- Signs of control or intimidation change how the bot talks: no "both sides"
  balancing and no joint exercises.

## Privacy: read this before deploying

- Private chats with the bot are encrypted in the database (AES-256-GCM), but
  whoever holds `DM_ENCRYPTION_KEY` can technically read them. The bot names
  that person (`ADMIN_NAME`) in the consent text each partner sees before using it.
- Messages are sent to Google Gemini. On the **free tier, Google may use the
  data to improve its products**; check the current
  [Gemini API terms](https://ai.google.dev/gemini-api/terms). Use a paid key if
  that is not acceptable to you.
- A daily cron job summarises old messages and deletes the originals.

## Stack

- Node.js 22+ functions on Vercel. Telegram updates go through Vercel Queues:
  one topic receives updates, another handles the debounce before the bot
  speaks.
- Supabase (Postgres + PostgREST) for memory. Atomic operations live in SQL
  functions, and row-level security is on with no policies, so only the
  service key has access.
- Google Gemini (`gemini-3.1-flash-lite` by default). The bot tracks its own
  daily quota and degrades in steps as it runs out: summaries first, then
  group replies. Private chats keep working to the end.
- Telegram Bot API over plain `fetch`.

## Set up your own

### 1. Telegram

1. Create a bot with [@BotFather](https://t.me/BotFather) and save the token.
2. In BotFather, open the bot's settings and turn on **Guest Mode**.
3. Create a group for the two of you. You will add the bot to it at the end.

### 2. Keys and config

```sh
git clone https://github.com/IvanSelivanov/couples-bot && cd couples-bot
npm install
cp .env.example .env
```

Fill in `.env` using the comments in the file. To generate the secrets:

```sh
openssl rand -hex 32                                   # WEBHOOK_SECRET, CRON_SECRET
node -e "import('./lib/crypto.js').then(m => console.log(m.generateKey()))"   # DM_ENCRYPTION_KEY
```

Get a Gemini API key from [Google AI Studio](https://aistudio.google.com/).
Set `ADMIN_NAME` to your own name, as it should appear in the consent text.

### 3. Run locally (optional)

Requires Docker.

```sh
npm run db:start      # local Supabase; prints API_URL and service_role key for .env
npm run bot           # long polling, no queues
```

### 4. Deploy

```sh
vercel login
npx supabase login
```

1. **Supabase.** Create a project. `vercel.json` pins functions to `fra1`
   (Frankfurt), so the closest Supabase region is `eu-central-1`. If you change
   the region, change both.
   ```sh
   npx supabase projects create couples-bot --region eu-central-1 --org-id <org> --db-password <password>
   npx supabase link --project-ref <ref>
   npx supabase db push
   npx supabase projects api-keys --project-ref <ref>   # take the service_role key
   ```
   Put the production values into `.env.production` (git-ignored):
   `SUPABASE_URL=https://<ref>.supabase.co` and `SUPABASE_SERVICE_KEY=<service_role>`.
2. **Vercel.** Run `vercel link` and create a new project. Queue triggers and
   the cron job are already defined in `vercel.json`.
3. **Environment variables:** `npm run push-env`. This copies the secrets from
   `.env` and the Supabase values from `.env.production` to Vercel production.
   Values are passed through stdin and never printed. Also keep a copy of
   `DM_ENCRYPTION_KEY` outside Vercel: if you lose the key, you lose the
   private chats.
4. **Deploy:** `vercel deploy --prod`.
5. **Webhook and commands:** `npm run setup https://<project>.vercel.app`.
   After this, do not run `npm run bot` against the same bot token, because
   polling removes the webhook.
6. Add the bot to your group as an admin, with only the **Pin messages** right,
   and send `/start` in the group. The bot walks you both through
   onboarding: language, country for help lines, time zone and consent.

### Rotating the encryption key

Move the old key to `DM_ENCRYPTION_KEY_PREV`, put the new key in
`DM_ENCRYPTION_KEY`, and increase `DM_ENCRYPTION_KEY_VERSION` by 1. The daily
cron re-encrypts old records. When its report shows `rewritten: 0`, remove
`DM_ENCRYPTION_KEY_PREV`.

## Tests and evals

```sh
npm test              # unit tests, no network or database
npm run test:db       # against local Supabase, migrations from scratch
npm run eval          # prompts against the live model, needs EVAL_GEMINI_API_KEY
```

The evals gate prompt changes. `npm run eval` exits with 1 if any threshold
fails. The thresholds cover these areas:
- when the bot speaks and when it stays silent;
- voice rules;
- crisis and abuse detection, where false positives must stay at 2% or below;
- sycophancy;
- leaking private notes;
- tone of voice-message summaries.

To choose which sets to run, use `EVAL_SETS=speak,false_positive`. For the
number of runs per case, use `EVAL_RUNS=1`. To print failing replies, use
`EVAL_VERBOSE=1`. A full run makes about 250 model calls.

`npm run spike:guest` is a manual probe of Telegram Guest Mode that checks
which ids arrive, whether media in the replied message can be downloaded, and
whether HTML and edits work.

## Notes for readers of the code

Code comments are in Russian. Tags like `DR12`, `R20` or `T13` refer to
decisions in the original design document, which is not published. The
comments next to each tag explain the decision itself.

## License

[MIT](LICENSE)
