# NVS Pay Log Mockup

## Frontend

Open `index.html` directly in a browser (offline is fine) to view the static UI. The page only references the local `style.css` file and does not depend on external assets.

## Backend

This project includes a small Node/Express server backed by Postgres and runs over HTTP by default.

1. Create the database schema:
   
   ```shell
   psql "$DATABASE_URL" -f db/schema.sql
   ```

2. Install dependencies and start the server:
   
   ```shell
   npm install  
   npm start
   ```

The server exposes:

- `GET /api/admin/session` to check whether the admin session is authenticated.
- `POST /api/admin/login` to authenticate and set the session cookie.
- `POST /api/admin/logout` to clear the session cookie.
- `GET /api/members` for the member list (requires login).
- `GET /api/members/:id` for the selected member's balance and transactions (requires login).

To import members, click **Import Members** and choose a `.csv` or `.xlsx` file  
that includes `id`, `first_name`, and `last_name` columns in any order.

Imported members start with a balance of `0`. If a member ID already exists,  
their balance is preserved. Imports from `.csv` and `.xlsx` both sync the  
member list, removing members (and their transactions) that are not present in  
the file after confirming in the UI.

## Deploy on a VM (Postgres + Node)

These steps run the database and web app on a single VM so the site is always
available online, and the app can be launched with `npm start`.

### 1) Provision a VM and open the port

1. Create a VM (e.g., Google Compute Engine).
2. Allow inbound traffic on the app port (default `3000`) in the VM firewall.
3. SSH into the VM.

### 2) Install dependencies

```sh
sudo apt-get update
sudo apt-get install -y nodejs npm postgresql
```

### 3) Set up Postgres and schema

```sh
sudo -u postgres psql
```

In the `psql` prompt:

```sql
CREATE DATABASE nvs_pay_log;
CREATE USER paylog_user WITH PASSWORD 'CHANGE_ME';
GRANT ALL PRIVILEGES ON DATABASE nvs_pay_log TO paylog_user;
\c nvs_pay_log
\i /path/to/Pay-Log/db/schema.sql
```

### 4) Update the admin password (database-only)

Passwords are hashed, so you can use the helper script to update the `Admin`
table directly from the VM (it prompts for current/new/confirm and hides input):

```sh
source ./db_cred
./change_pw
```

If you prefer to apply a hash manually, generate a bcrypt hash and update the
`Admin` table directly from the VM:

```sh
npm run hash-password -- "NEW_PASSWORD"
```

Then in `psql`:

```sql
DELETE FROM "Admin";
INSERT INTO "Admin" (password) VALUES ('PASTE_BCRYPT_HASH_HERE');
```

### 5) Run the web app with npm

From the repo root on the VM:

```sh
npm install
export DATABASE_URL="postgres://paylog_user:CHANGE_ME@localhost/nvs_pay_log"
npm start
```

Your app will be available at `http://VM_PUBLIC_IP:3000`.

## Link to the app from another webpage

Use the VM URL in a normal link that opens a new tab:

```html
<a href="http://VM_PUBLIC_IP:3000" target="_blank" rel="noopener noreferrer">
  Open Pay Log
</a>
```
