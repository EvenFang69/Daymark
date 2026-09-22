FROM python:3.12-slim

WORKDIR /app

COPY app.py ai_client.py journal_memory.py ./
COPY prompts ./prompts
COPY static ./static

ENV PYTHONUNBUFFERED=1 \
    JOURNAL_HOST=0.0.0.0 \
    JOURNAL_PORT=8765 \
    JOURNAL_DB_PATH=/app/data/journal.sqlite3

EXPOSE 8765

CMD ["python3", "app.py"]
