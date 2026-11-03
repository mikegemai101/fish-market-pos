# Fish Vendor POS

Current version: **v1.0.8**. Releases use matching Git tags and Docker Hub tags.

A web point of sale app for fish vendors, with weight-based checkout, barcode scanning and printing, stock tracking, cashier and shop manager roles, sales dashboards, CSV/PDF reports, MariaDB, phpMyAdmin, and Caddy HTTPS.

## Cloud VM deployment

### 1. Prepare the VM and DNS

- Install Docker Engine and the Docker Compose plugin using the instructions for your VM's Linux distribution.
- Assign a stable public IP to the VM. Create an `A` record for the POS hostname pointing to that IP. If you publish an `AAAA` record, it must point to this VM too; otherwise remove it.
- In the cloud firewall and VM firewall, allow inbound SSH from trusted IPs, TCP ports **80** and **443**, and UDP port **443**. Do not open MariaDB port 3306 or phpMyAdmin port 8080 publicly.
- Install this repository in a stable directory on the VM. Keep using that same directory and Compose project name so Docker keeps using the same named data volumes.

### 2. Configure secrets

Copy the example and edit it:

```sh
cp .env.example .env
nano .env
chmod 600 .env
```

Set `DOMAIN` to the real DNS hostname. Generate separate random values for `DB_PASSWORD`, `DB_ROOT_PASSWORD`, and `JWT_SECRET` by running `openssl rand -hex 32` three times. Generate a separate admin password with at least 12 characters. `JWT_SECRET` must be at least 32 characters; the app refuses to start without it, and the first admin account cannot be created with a password under 12 characters. Keep `.env` private and do not commit it.

`ADMIN_PASSWORD` is only used to create the first admin account when the database is empty. Changing it later does not change an existing user's password. After first startup, admins can change their password in Management. Use the documented password reset script if it is forgotten.

### 3. Start the stack

Run these commands from the project directory:

```sh
docker compose pull
docker compose up -d
docker compose ps
```

Caddy obtains and renews HTTPS certificates automatically after DNS resolves to the VM and inbound ports 80 and 443 are reachable. Allow a short time for the first certificate. Open `https://your-domain` for the POS.

The app container runs read-only except for its persistent uploads volume. MariaDB has no public port. Caddy's certificate data, MariaDB data, and uploaded images are stored in named Docker volumes and survive container replacement.

### Automatic deployments

Pushes to `main` publish `latest`, the version in `package.json` (currently `1.0.8`), and a matching GitHub Release with generated release notes. Increment the package version before each change pushed to `main` so every update gets its own versioned image and release. The workflow deploys that exact tag to the VM when deployment settings are configured. Add these GitHub Actions repository variables:

- `DEPLOY_HOST`: VM hostname or IP address.
- `DEPLOY_USER`: SSH user with permission to run Docker Compose.
- `DEPLOY_PATH`: absolute path to the deployed project directory containing `docker-compose.yml` and `.env`.
- `DEPLOY_PORT`: SSH port; optional, defaults to `22`.

Add these GitHub Actions repository secrets:

- `DEPLOY_SSH_KEY`: private SSH key for the deployment user.
- `DEPLOY_KNOWN_HOSTS`: verified SSH host key entry for the VM (use `[host]:port` for a non-default port).

After publishing the image, the workflow fast-forwards the project checkout, pulls the exact versioned image, and recreates only the app container. The database, uploads, and other services stay running.

### phpMyAdmin access

phpMyAdmin is bound to the VM's loopback interface only. Use an SSH tunnel from your computer:

```sh
ssh -L 8080:127.0.0.1:8080 your-vm-user@your-domain
```

Keep that SSH session open and visit `http://127.0.0.1:8080` locally. Sign in with `DB_USER` and `DB_PASSWORD` for routine access; use the database root account only when administrative privileges are needed. The phpMyAdmin port is intentionally not exposed through Caddy or the public firewall.

### Updating the app

To update manually, change `APP_IMAGE` in `.env` to the desired Docker Hub tag, then run:

```sh
docker compose pull app
docker compose up -d app
```

Keep the `fish_data`, `fish_uploads`, `caddy_data`, and `caddy_config` volumes. Do not use `docker compose down -v` for routine updates; `-v` deletes the persistent database, uploaded logo/product images, and Caddy certificate data.

### Backups

Back up MariaDB and uploaded images regularly and copy the backups off the VM. Run from the project directory:

```sh
docker compose exec -T db sh -c 'mariadb-dump --single-transaction -uroot -p"$MARIADB_ROOT_PASSWORD" "$MARIADB_DATABASE"' > fishpos-database.sql
docker compose exec -T app tar -czf - -C /app/uploads . > fishpos-uploads.tar.gz
```

Protect backup files like passwords: they contain business and possibly customer data. Test restoring backups before relying on them.

### Troubleshooting

- `docker compose ps` shows service state and health. Inspect startup logs with `docker compose logs --tail=100 app db caddy`.
- If HTTPS does not start, verify the DNS `A`/`AAAA` records and cloud/VM firewall access to ports 80 and 443.
- If the POS cannot connect to MariaDB, confirm the `.env` database values have not changed after the `fish_data` volume was initialized. Updating `.env` does not rotate credentials in an existing database volume.
- Existing products start with 0 kg when inventory is first migrated. Enter their current stock in Management → Inventory before selling them.

## Accounts and access

- **Admin:** full access to products, categories, inventory, users, dashboard, exports, and branding settings. Admins can add stock and remove stock to correct an inventory mistake; removal cannot take stock below zero.
- **Shop Manager:** view the dashboard; add and view fish and inventory; export overall sales or sales filtered by cashier.
- **Cashier:** Point of Sale and limited Management access to view fish and inventory, print labels, and export their own sales. Cashiers cannot adjust stock, edit or remove products, manage categories or accounts, or view the dashboard. These permissions are enforced server-side.

Fish inventory uses kilograms. Each completed sale deducts sold weight transactionally. Fish images are limited to 5 MB. Brand settings, database data, and uploaded images are persisted in Docker volumes.

Admins can change the brand name and upload a replacement logo from Management → Brand name and logo. For a forgotten admin password, run this on the VM from the project directory, replacing `admin` with the account name:

```sh
docker compose exec -it app node scripts/reset-admin-password.js admin
```

The script prompts for a new password without displaying it, hashes it, and updates the admin account.

## Barcode scanner

Most USB scanners behave like a keyboard. Focus the barcode field on checkout, scan an EAN-13 or UPC-A label, then the scanner's Enter suffix adds the matching fish. Weight is entered at checkout.

## Releases and Docker Hub

The GitHub Actions workflow publishes Docker images on pushes to `main` and semantic version tags (`v*.*.*`). Configure `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` in GitHub Actions secrets. For each release, create a matching GitHub tag/release and Docker Hub tag; deployments should use a versioned tag rather than `latest` so upgrades are controlled.
