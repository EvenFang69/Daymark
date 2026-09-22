# Daymark

Daymark is a local-first personal AI journal and review system. It keeps the original note as evidence, lets an AI model organize messy natural-language entries, and builds traceable daily and weekly reviews.

## Features

- Chat-style recording with original text saved before AI processing.
- Background AI analysis with structured JSON output and optional follow-up questions.
- Date hints, business-day cutoff, timeline, calendar review, daily/weekly reports, and source links.
- Current-focus rollups that compress repeated next actions without deleting their history.
- Attachments for images, documents, and other files.
- SQLite storage, JSON/Markdown/SQLite export, and PWA-friendly responsive UI.
- Works without an AI key: records remain available and are never replaced by a fake summary.

## Requirements

- Python 3.10 or newer
- No third-party Python package is required for the basic app
- An OpenAI-compatible API is optional for AI processing

## Run Locally

```bash
cp .env.example .env
python3 app.py
```

Open `http://127.0.0.1:8765`. To use another device on the same network, set `JOURNAL_HOST=0.0.0.0` and open the LAN address printed by the server. Do not expose the development server directly to the public internet.

The first run creates an empty SQLite database at `data/journal.sqlite3`. The database and uploaded files are intentionally ignored by Git.

## AI Configuration

Copy `.env.example` to `.env` and set:

```dotenv
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=your-key
OPENAI_MODEL_SIMPLE=gpt-4o-mini
OPENAI_MODEL_REASONING=gpt-4o
OPENAI_MODEL_REPORT=gpt-4o-mini
OPENAI_MODEL_LONG=gpt-4o
```

Keep `.env` local. Never commit API keys, tokens, passwords, personal databases, exports, logs, or uploaded files.

## Data and Privacy

The application is designed for personal, local-first use. SQLite is the source of truth for original entries, conversation messages, AI versions, reports, corrections, relationships, proposals, and rollups. Exported data is intended for migration and testing. The public repository contains no personal database or real user records.

For production use, put the app behind HTTPS, keep the database on a persistent private volume, and configure backups outside the repository.

## Tests

```bash
python3 -m unittest discover -s tests -p 'test_*.py'
node --test tests/*.test.cjs
```

The test suite uses temporary databases and synthetic example text.

## License

MIT. See [LICENSE](LICENSE).
