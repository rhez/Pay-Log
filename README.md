# NVS Pay Log Mockup

## Frontend

Open `index.html` directly in a browser (offline is fine) to view the static UI. The page only references the local `style.css` file and does not depend on external assets.

## Backend

This project includes a small Node/Express server backed by Postgres and runs over HTTP by default.

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

## Deploy on Google Cloud (Cloud Run + Cloud SQL)

These steps create a Postgres database, deploy the Node/Express app to Cloud Run,
and configure the `DATABASE_URL` connection string.

### 1) Create a Cloud SQL Postgres instance

1. In Google Cloud Console, create a project and enable billing.
2. Enable the **Cloud SQL Admin API** and **Cloud Run API**.
3. Go to **Cloud SQL** → **Create Instance** → **PostgreSQL**.
4. Create a database named `nvs_pay_log` and a database user/password.
5. Note the **instance connection name** in the format:
   `PROJECT_ID:REGION:INSTANCE_NAME`.

### 2) Apply the schema

Connect to the database and apply the schema from `db/schema.sql`:

```sh
gcloud sql connect INSTANCE_NAME --user=DB_USER
```

Then in the `psql` prompt:

```sql
\c nvs_pay_log
\i db/schema.sql
```

### 3) Deploy to Cloud Run

From the repo root:

```sh
gcloud config set project PROJECT_ID
gcloud services enable run.googleapis.com sqladmin.googleapis.com artifactregistry.googleapis.com

gcloud run deploy pay-log \
  --source . \
  --region REGION \
  --allow-unauthenticated \
  --add-cloudsql-instances=PROJECT_ID:REGION:INSTANCE_NAME \
  --set-env-vars=DATABASE_URL="postgres://DB_USER:DB_PASSWORD@/nvs_pay_log?host=/cloudsql/PROJECT_ID:REGION:INSTANCE_NAME"
```

When the deploy completes, Cloud Run will output a service URL (for example
`https://pay-log-xxxxx-uc.a.run.app`). Use that URL in the link below.

## Link to the app from another webpage

Use the Cloud Run service URL in a normal link that opens a new tab:

```html
<a href="https://pay-log-xxxxx-uc.a.run.app" target="_blank" rel="noopener noreferrer">
  Open Pay Log
</a>
```
