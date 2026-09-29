# couples-bot

A Telegram bot for one couple. In your shared group chat it acts as a calm
conversation helper: it notices when a conversation gets stuck and helps you
two hear each other. If you write in different languages, it also translates.
Each partner also gets a private chat with it.

It is a non-commercial side project, and it is not a therapist. Everyone runs
their own copy: one copy serves one couple, and the person who sets it up
controls the data.

- [What it does](#what-it-does)
- [Privacy: read this first](#privacy-read-this-first)
- [Set it up: step-by-step guide for beginners](#set-it-up-step-by-step-guide-for-beginners)
- [Stuck? Ask a free AI assistant](#stuck-ask-a-free-ai-assistant)
- [For developers](#for-developers)

## What it does

**In your shared group**
- Waits for a pause in the conversation and speaks only when there is tension,
  a misunderstanding or a question addressed to it. It never takes sides and
  asks one question at a time.
- Offers an understanding check: each of you restates what you heard.
- When a conversation calms down, posts a short recap: what got clarified and
  what is still open.
- Translates messages between your languages (meaning and tone, not word by
  word). `/translate` turns this on and off.
- Transcribes voice messages and video notes.
- `/pause` silences the bot.

**In a private chat with each partner**
- A private helper that knows the shared conversation, talks like a friend of
  you both, and helps you figure out what happened.
- `/draft` helps you phrase a message to your partner before you send it.
- `/notes`: things you want the bot to keep in mind. A note is used in the
  shared conversation only if you allow it, and it is never quoted word for word.
- `/menu` → data controls: delete your chat, delete the shared history,
  withdraw consent.

**In your own 1:1 chat with your partner (Telegram Guest Mode)**
- Reply to your partner's message (text, voice or video note) with
  `@your_bot what did they mean?` and the bot explains it in both languages,
  as possible readings rather than verdicts.

**Safety**
- If a message looks like a crisis (a threat to hurt someone, self-harm), the
  bot sends help-line numbers for each partner's country. It doesn't ask the AI
  model anything at that moment: the numbers are looked up and checked in advance.

## Privacy: read this first

- Your private chats with the bot are encrypted in the database, but the person
  who sets up the bot holds the key and can technically read them. The bot says
  so, by name, before each partner agrees to use it.
- Messages are processed by Google Gemini. On Google's **free tier, Google may
  use the data to improve its products**; see the
  [Gemini API terms](https://ai.google.dev/gemini-api/terms). If that's not OK
  for you, use a paid Gemini key.
- Old messages are summarised and the originals deleted automatically: private
  chats after a few days, the group history after 90 days.

## Set it up: step-by-step guide for beginners

You don't need to be a programmer or install anything. Everything happens in
the browser and in Telegram, and everything here is free. Plan for about 30
minutes.

If you get stuck at any step, see [Stuck? Ask a free AI assistant](#stuck-ask-a-free-ai-assistant).

### What you need

- Telegram on your phone or computer.
- A Google account (for the Gemini AI key).
- A [GitHub](https://github.com/signup) account. Your copy of the bot's code
  will live there. Signing up is free.

### Step 1. Create your Telegram bot

1. In Telegram, open [@BotFather](https://t.me/BotFather) and send `/newbot`.
2. Choose a name (e.g. `Our helper`) and a username that ends in `bot`
   (e.g. `anna_and_tom_helper_bot`).
3. BotFather replies with a **token** that looks like `123456789:AAH...`. Keep it
   secret: whoever has it controls your bot. You'll paste it in step 3.
4. Turn on **Guest Mode**: in BotFather, open your bot's settings (tap **Open**
   to use the BotFather app, choose your bot) and switch Guest Mode on. This lets
   you call the bot in your 1:1 chat with your partner.

### Step 2. Get a Gemini AI key

1. Go to [Google AI Studio → API keys](https://aistudio.google.com/api-keys) and sign in.
2. Click **Create API key**. When asked for a project, choose **Create project**
   and name it e.g. `couples-bot`. A separate project means the bot gets its own
   free daily limit.
3. Copy the key. You'll paste it in step 3.

### Step 3. Deploy

Click this button:

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FIvanSelivanov%2Fcouples-bot&project-name=couples-bot&repository-name=couples-bot&env=BOT_TOKEN,GEMINI_API_KEY,ADMIN_NAME,DM_ENCRYPTION_KEY&envDescription=Your%20Telegram%20bot%20token%2C%20a%20Gemini%20API%20key%2C%20your%20name%20for%20the%20consent%20text%2C%20and%20a%20passphrase%20%2816%2B%20characters%29%20that%20encrypts%20private%20chats.&envLink=https%3A%2F%2Fgithub.com%2FIvanSelivanov%2Fcouples-bot%23step-3-deploy&stores=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22supabase%22%2C%22productSlug%22%3A%22supabase%22%2C%22protocol%22%3A%22storage%22%7D%5D)

1. **Sign in to Vercel with GitHub.** If you have no Vercel account, this creates
   a free one (the **Hobby** plan).
2. **Create the Git repository.** Vercel copies the bot's code into your GitHub
   account. Keep the suggested name and make the repository **private** if asked.
3. **Add Supabase** (the database). Click **Add** next to Supabase and follow
   the prompts: create or connect a Supabase account, choose the **Free** plan,
   and if you're asked for a region, pick **Frankfurt (eu-central-1)**, the one
   closest to where the bot runs. Vercel connects the database for you.
4. **Fill in four settings:**

   | Setting | What to put there |
   |---|---|
   | `BOT_TOKEN` | the token from BotFather |
   | `GEMINI_API_KEY` | the key from AI Studio |
   | `ADMIN_NAME` | your name, as your partner knows you. The bot shows it to both of you: you are the person who can technically read the private chats |
   | `DM_ENCRYPTION_KEY` | a passphrase of at least 16 characters that encrypts your private chats. Your password manager can generate one, or use 5 or more random words, e.g. `violet lantern orbit pickle seventeen`. **Save it somewhere safe:** if you lose it, the private chats can't be read anymore |

5. Click **Deploy** and wait a couple of minutes. While building, the bot
   creates its database tables and connects itself to Telegram.
6. When you see the congratulations screen, the bot is online.

If the build fails, open it: the last lines of the log say which setting is
wrong and what to put there. Fix it in **Vercel → your project → Settings →
Environment Variables**, then go to **Deployments**, open the ⋯ menu of the
latest one and choose **Redeploy**.

### Step 4. Start using it

1. In Telegram, create a group with just you and your partner, and add your bot.
2. Make the bot an admin: tap the group name → **Edit** (the pencil on Android)
   → **Administrators** → **Add Admin** → your bot. Turn off every permission
   except **Pin messages**, then save. The bot needs admin status to see all
   messages and to check that only the two of you are in the group; it won't
   delete anything or ban anyone.
3. Send `/start` in the group.
4. The bot posts a message with an **Open the bot** button. Each of you taps it
   and answers a few questions in a private chat: language, country, time,
   and consent.
5. When both of you have agreed, the bot says it's ready in the group.

### If something goes wrong

- **The bot doesn't answer in the group.** Check that it's an admin and that the
  group has exactly three members: the two of you and the bot.
- **The bot doesn't react to anything at all.** In Vercel, open your project →
  **Deployments** and check that the latest production deployment is **Ready**.
  If it failed, the end of its build log says why.
- **The bot says it can't answer right now, or talks about a limit.** The free
  Gemini quota (500 requests a day) resets at midnight Pacific time.
- **You want to change a setting.** Edit it in **Settings → Environment
  Variables**, then **Redeploy** the latest deployment.
- **You want to see what the bot is doing.** Your project in Vercel →
  **Logs**. The logs never contain message text.
- **You want the latest version of the bot.** Your copy doesn't update itself.
  Ask the AI assistant below how to pull changes from
  `IvanSelivanov/couples-bot` into your repository; Vercel redeploys on every change.

## Stuck? Ask a free AI assistant

A chat assistant can walk you through the steps above and read your error
messages. [Google Gemini](https://gemini.google.com) is a good fit: it's free,
you already have a Google account from step 2, and you can send it screenshots.
The free versions of [ChatGPT](https://chatgpt.com) or [Claude](https://claude.ai)
work just as well.

Start a new chat, paste the prompt below, then paste this whole README after it.

```text
You are helping me, a non-programmer, set up a Telegram bot called couples-bot.
The setup happens in the browser (Telegram, Google AI Studio, Vercel, Supabase, GitHub);
there is no terminal. I'll paste the bot's README below. Follow its
"Set it up: step-by-step guide for beginners" section.

How to help me:
- Go one step at a time. Give me one small action, then wait until I tell you it worked
  or show you what happened. Don't jump ahead.
- Explain in plain words and tell me exactly where to click.
- When something fails, ask me for the exact error text or a screenshot of it. Don't guess.
  If a Vercel build fails, ask me to open the build log and copy its last 20 lines.
- Never ask me to paste my tokens, keys, passphrase or passwords into this chat. If you need
  to know whether a value is right, ask me what it looks like (for example, how it starts and
  how long it is), not the value itself. If a screenshot might show a key or token, remind me
  to cover it first.
- If the README and what I see on screen don't match (websites change), help me find the
  closest equivalent instead of insisting on the README wording.

Here is the README:
```

Don't paste your bot token, keys or passphrase into any chat, AI or not.

## For developers

### Stack

- Node.js 22+ functions on Vercel. Telegram updates go through Vercel Queues:
  one topic receives updates, another handles the debounce before the bot speaks.
- Supabase (Postgres + PostgREST) for memory. Atomic operations live in SQL
  functions; row-level security is on with no policies, so only the service key
  has access.
- Google Gemini (`gemini-3.1-flash-lite` by default, `GEMINI_MODEL` to change).
  The bot tracks its own daily quota and degrades in steps as it runs out:
  summaries first, then group replies. Private chats keep working to the end.
- Telegram Bot API over plain `fetch`.

### How deploys work

`vercel.json` runs `scripts/vercel-build.js` as the build command. On every
build it checks the settings and fails with a readable list if something is
missing (previews only warn). On production builds it also:

1. applies database migrations with `supabase db push`, using
   `SUPABASE_DB_URL` or the Supabase integration's `POSTGRES_URL_NON_POOLING`;
2. sets the Telegram webhook and commands for `VERCEL_PROJECT_PRODUCTION_URL`.

Secrets a one-click setup doesn't ask for have fallbacks:
- `WEBHOOK_SECRET` is derived from the bot token;
- `BOT_USERNAME` comes from `getMe`;
- `DM_ENCRYPTION_KEY` may be a passphrase (stretched with scrypt) or a raw
  32-byte base64 key;
- without `CRON_SECRET`, `/api/cron` runs maintenance at most once per 20 hours,
  guarded by a database lock.

### Manual setup from the command line

The same result as the Deploy button, but with your own Supabase project and the
Vercel CLI. Needs Node.js 22+.

```sh
git clone https://github.com/IvanSelivanov/couples-bot && cd couples-bot
npm install
cp .env.example .env                  # fill in: see the comments in the file
npx supabase login
npx supabase projects create couples-bot --region eu-central-1 --org-id <org> --db-password <password>
npx supabase link --project-ref <ref>
```

Create `.env.production` with `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` (the
service_role key, or a `sb_secret_` key) and `SUPABASE_DB_URL` (the session
pooler connection string from the Supabase dashboard's **Connect** dialog). Then:

```sh
npx vercel login
npx vercel link                       # create a new project
npm run push-env                      # .env and .env.production → Vercel production
npx vercel deploy --prod              # migrations and Telegram setup run in the build
```

Connecting the Vercel project to your GitHub repository (Project → Settings → Git)
makes every push to `main` deploy.

### Run locally

Requires Docker.

```sh
npm install
npm run db:start      # local Supabase; prints API_URL and the service_role key for .env
npm run bot           # long polling, no queues
```

Local polling removes the webhook. After testing locally, run `npm run setup`
again to point Telegram back to the deployed bot.

### Tests and evals

```sh
npm test              # unit tests, no network or database
npm run test:db       # against local Supabase, migrations from scratch
npm run eval          # prompts against the live model, needs EVAL_GEMINI_API_KEY
```

The evals gate prompt changes: `npm run eval` exits with 1 if any threshold
fails. They cover when the bot speaks and when it stays silent, voice rules,
crisis and abuse detection (false positives must stay at 2% or below),
sycophancy, leaking private notes, voice-message summaries and the private
chat. `EVAL_SETS=speak,dm` picks sets, `EVAL_RUNS=1` sets runs per case,
`EVAL_VERBOSE=1` prints failing replies. A full run makes about 300 model calls
and paces itself to the free tier's 15 requests a minute.

`npm run spike:guest` is a manual probe of Telegram Guest Mode: which ids
arrive, whether media in the replied message can be downloaded, whether HTML
and edits work. Results of the 2026-09-29 run: in a 1:1 chat `chat.type` is
`private` and `chat.id` is the other person's id; `reply_to_message` arrives in
full and its voice or video note can be downloaded; there's no `language_code`;
HTML, `expandable` and edits via `inline_message_id` work; a reply after 60 s is
accepted.

### Rotating the encryption key

Move the old key or passphrase to `DM_ENCRYPTION_KEY_PREV`, put the new one in
`DM_ENCRYPTION_KEY`, and set `DM_ENCRYPTION_KEY_VERSION` to the next number
(it's 1 when unset). The daily
cron re-encrypts old records. When its report shows `rewritten: 0`, remove
`DM_ENCRYPTION_KEY_PREV`.

### Reading the code

Tags like `DR12`, `R20` or `T13` in comments refer to decisions in the original
design document, which is not published. The comment next to each tag explains
the decision itself.

## License

[MIT](LICENSE)
