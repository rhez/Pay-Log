# NVS Pay Log Mockup

## Frontend

Open `index.html` directly in a browser (offline is fine) to view the static UI. The page only references the local `style.css` file and does not depend on external assets.

## Backend

This project includes a small Node/Express server backed by Postgres.

1. Create the database schema:

   ```sh
   psql "$DATABASE_URL" -f db/schema.sql
   ```

2. Generate a local TLS certificate (required for HTTPS cookies):

   ```sh
   mkdir -p certs
   openssl req -x509 -newkey rsa:2048 -nodes \
     -keyout certs/localhost-key.pem \
     -out certs/localhost-cert.pem \
     -days 365 \
     -subj "/CN=localhost"
   ```

3. Install dependencies and start the server:

   ```sh
   npm install
   SSL_KEY_PATH=certs/localhost-key.pem \
   SSL_CERT_PATH=certs/localhost-cert.pem \
   npm start
   ```

The server exposes:

- `GET /api/admin/session` to check whether the admin session is authenticated.
- `POST /api/admin/login` to authenticate and set the session cookie.
- `POST /api/admin/logout` to clear the session cookie.
- `POST /api/admin/password` to update the admin password (requires login).
- `GET /api/members` for the member list (requires login).
- `GET /api/members/:id` for the selected member's balance and transactions (requires login).

To import members, click **Import Members** and choose a `.csv` or `.xlsx` file
that includes `id`, `first_name`, and `last_name` columns in any order.

Imported members start with a balance of `0`. If a member ID already exists,
their balance is preserved. Imports from `.csv` and `.xlsx` both sync the
member list, removing members (and their transactions) that are not present in
the file after confirming in the UI.
