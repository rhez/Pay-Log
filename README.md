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

To import members, click **Import Members** and choose a `.csv` or `.xlsx` file
formatted as:

```
<id>, <first_name>, <last_name>
```

Imported members start with a balance of `0`. If a member ID already exists,
their balance is preserved. Imports from `.csv` and `.xlsx` both sync the
member list, removing members (and their transactions) that are not present in
the file after confirming in the UI.
