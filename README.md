# NVS Pay Log Mockup

## Frontend

Open `index.html` directly in a browser (offline is fine) to view the static UI. The page only references the local `style.css` file and does not depend on external assets.

## Backend

This project includes a small Node/Express server backed by Postgres.

1. Create the database schema:

   ```sh
   psql "$DATABASE_URL" -f db/schema.sql
   ```

2. Install dependencies and start the server:

   ```sh
   npm install
   npm start
   ```

The server exposes:

- `GET /api/members` for the member list (pre-formatted with zero-padded IDs).
- `GET /api/members/:id` for the selected member's balance and transactions.
