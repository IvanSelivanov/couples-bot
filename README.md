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

You don't need to be a programmer. You will copy commands into a terminal and
fill in one settings file. Plan for about an hour. Everything here is free.

If you get stuck at any step, see [Stuck? Ask a free AI assistant](#stuck-ask-a-free-ai-assistant).

### What you need

- A computer with macOS, Windows or Linux.
- Telegram on your phone or computer.
- A Google account (for the Gemini AI key).
- Free accounts at [Supabase](https://supabase.com) (the database) and
  [Vercel](https://vercel.com) (where the bot runs). You can sign up with Google
  or GitHub.

### Step 1. Install Node.js

Node.js runs the setup scripts.

1. Go to [nodejs.org](https://nodejs.org) and download the **LTS** version.
2. Run the installer and click through with the default options.
3. Open a terminal:
   - **macOS:** press `Cmd + Space`, type `Terminal`, press Enter.
   - **Windows:** press the Windows key, type `PowerShell`, press Enter.
4. Type this and press Enter:
   ```sh
   node --version
   ```
   You should see something like `v22.x` or `v24.x`. The number must be 22 or higher.

### Step 2. Download the bot

1. On the [project page](https://github.com/IvanSelivanov/couples-bot), click
   the green **Code** button → **Download ZIP**.
2. Unzip it somewhere easy to find, e.g. your Documents folder. You'll get a
   folder named `couples-bot-main`.
3. In the terminal, go into that folder. Type `cd ` (with a space at the end),
   drag the folder from Finder or Explorer into the terminal window, and press Enter.
4. Install the bot's parts:
   ```sh
   npm install
   ```
   This takes a minute. Warnings are fine; errors in red are not.

**From now on, run every command in this folder.** If you close the terminal,
repeat step 3 when you open it again.

### Step 3. Create your Telegram bot

1. In Telegram, open [@BotFather](https://t.me/BotFather) and send `/newbot`.
2. Choose a name (e.g. `Our helper`) and a username that ends in `bot`
   (e.g. `anna_and_tom_helper_bot`).
3. BotFather replies with a **token** that looks like `123456789:AAH...`. Keep it
   secret: whoever has it controls your bot.
4. Turn on **Guest Mode**: in BotFather, open your bot's settings (tap **Open**
   to use the BotFather app, choose your bot) and switch Guest Mode on. This lets
   you call the bot in your 1:1 chat with your partner.

### Step 4. Get a Gemini AI key

1. Go to [Google AI Studio → API keys](https://aistudio.google.com/api-keys) and sign in.
2. Click **Create API key**. When asked for a project, choose **Create project**
   and name it e.g. `couples-bot`. A separate project means the bot gets its own
   free daily limit.
3. Copy the key.

### Step 5. Fill in the settings file

1. In the `couples-bot-main` folder, make a copy of `.env.example` and name the
   copy `.env`. On macOS the file is hidden: in Finder press
   `Cmd + Shift + .` to show hidden files. On Windows, turn on
   **View → Show → File name extensions** first, so you don't end up with `.env.txt`.
2. Open `.env` in a plain text editor (TextEdit on macOS, Notepad on Windows)
   and fill in:

   | Line | What to put there |
   |---|---|
   | `BOT_TOKEN=` | the token from BotFather |
   | `BOT_USERNAME=` | your bot's username, without `@` |
   | `GEMINI_API_KEY=` | the key from AI Studio |
   | `GEMINI_DAILY_LIMIT=` | `500` |
   | `ADMIN_NAME=` | your name, as your partner knows you |
   | `DM_ENCRYPTION_KEY_VERSION=` | `1` |

3. Three lines need random secrets. Run this command three times, and paste
   each result into one of the lines:
   ```sh
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
   → `WEBHOOK_SECRET=`, `CRON_SECRET=`.
   For `DM_ENCRYPTION_KEY=` use this command instead:
   ```sh
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```
   **Save `DM_ENCRYPTION_KEY` somewhere else too**, e.g. in your password
   manager. If you lose it, the private chats can't be read anymore.
4. Leave the other lines empty and save the file.

Never share `.env` or post its contents anywhere: it contains everything
needed to control your bot.

### Step 6. Create the database (Supabase)

1. Sign up at [supabase.com](https://supabase.com) and click **New project**.
   - Name: `couples-bot`.
   - Database password: click **Generate a password**, then copy it and keep it
     (e.g. in your password manager).
   - Region: **Central EU (Frankfurt)** is the best match for the bot's settings.
     Pick another region only if you know why.
2. Wait until the project is ready (a minute or two).
3. Look at the address bar: `supabase.com/dashboard/project/`**`abcdefghijklmnop`**.
   That last part is your **project ref**.
4. In the terminal, log in and create the tables:
   ```sh
   npx supabase login
   npx supabase link --project-ref YOUR_PROJECT_REF
   npx supabase db push
   ```
   `login` opens your browser to confirm. `link` asks for the database password
   from step 1. `db push` asks for confirmation: press `Y`.
5. In the Supabase dashboard open **Project Settings → API Keys → Legacy API
   Keys** and reveal the **service_role** key. It's a long string starting
   with `eyJ`.
6. Create one more file in the folder, `.env.production`, with two lines:
   ```
   SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
   SUPABASE_SERVICE_KEY=the service_role key
   ```
   This key gives full access to your database: keep it as secret as `.env`.

### Step 7. Put the bot online (Vercel)

1. Sign up at [vercel.com](https://vercel.com) (the free **Hobby** plan).
2. In the terminal:
   ```sh
   npx vercel login
   npx vercel link
   ```
   `link` asks a few questions: answer **yes** to set up the project, pick your
   account, answer **no** to linking an existing project, and accept the
   suggested defaults for the rest.
3. Send your settings to Vercel:
   ```sh
   npm run push-env
   ```
   Every line should end with `ok`.
4. Deploy:
   ```sh
   npx vercel deploy --prod
   ```
   At the end you'll see a line like `Aliased https://couples-bot-xyz.vercel.app`.
   That address is your bot's home.
5. Connect Telegram to it:
   ```sh
   npm run setup https://couples-bot-xyz.vercel.app
   ```
   Use your own address. You should see `Webhook set` and `Commands set`.

### Step 8. Start using it

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
- **`npm run push-env` says `Not filled in: ...`.** The named lines in `.env` or
  `.env.production` are empty.
- **The bot answers "I can't answer right now" or talks about a limit.** The
  free Gemini quota (500 requests a day) resets at midnight Pacific time.
- **You changed something in `.env`.** Run `npm run push-env` and
  `npx vercel deploy --prod` again.
- **You want to see what the bot is doing.** Run
  `npx vercel logs https://couples-bot-xyz.vercel.app` (your address) in the
  folder. The logs never contain message text.

## Stuck? Ask a free AI assistant

A chat assistant can walk you through the steps above and read your error
messages. [Google Gemini](https://gemini.google.com) is a good fit: it's free,
you already have a Google account from step 4, and you can send it screenshots.
The free versions of [ChatGPT](https://chatgpt.com) or [Claude](https://claude.ai)
work just as well.

Start a new chat, paste the prompt below, then paste this whole README after it.

```text
You are helping me, a non-programmer, set up a Telegram bot called couples-bot on my own computer.
I'll paste its README below. Follow the "Set it up: step-by-step guide for beginners" section.

How to help me:
- Go one step at a time. Give me one small action, then wait until I tell you it worked
  or show you what happened. Don't jump ahead.
- My computer runs: [macOS / Windows / Linux — write yours].
- Explain in plain words. If I have to type a command, show it in a separate block
  and tell me where to type it.
- When something fails, ask me for the exact error text or a screenshot of it. Don't guess.
- Never ask me to paste my tokens, keys or passwords into this chat. If you need to know
  whether a value is right, ask me what it looks like (for example, how it starts and how
  long it is), not the value itself. If a screenshot might show a key or token, remind me
  to cover it first.
- If the README and what I see on screen don't match (websites change), help me find the
  closest equivalent instead of insisting on the README wording.

Here is the README:
```

Don't paste the contents of your `.env` or `.env.production` files into any
chat, AI or not.

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

Move the old key to `DM_ENCRYPTION_KEY_PREV`, put the new key in
`DM_ENCRYPTION_KEY`, and increase `DM_ENCRYPTION_KEY_VERSION` by 1. The daily
cron re-encrypts old records. When its report shows `rewritten: 0`, remove
`DM_ENCRYPTION_KEY_PREV`.

### Reading the code

Tags like `DR12`, `R20` or `T13` in comments refer to decisions in the original
design document, which is not published. The comment next to each tag explains
the decision itself.

## License

[MIT](LICENSE)
