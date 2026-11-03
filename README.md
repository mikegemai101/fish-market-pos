# My.Co Enterprises — Fish Vendor POS

A small point of sale app for a fish counter. Cashiers can scan a barcode or select a fish, enter its weight in kilograms, and complete a sale. Admins manage fish names, categories, photos, per-kilogram pricing, barcode labels, inventory in kilograms, users, and recent sales. Cashiers can filter the checkout catalog by category while the sale basket stays in view. The header clock always uses GMT+8.

## Run with Docker Compose

1. Copy `.env.example` to `.env` and replace every placeholder with strong, unique values. Keep `.env` private; it is excluded from Git and the Docker build context.
2. Set `DOMAIN` to a hostname that points to this server. For local-only use, set `DOMAIN=localhost`.
3. Start the services:

   ```sh
   docker compose pull app
   docker compose up -d
   ```

4. Open `https://your-domain` to use the POS and `https://your-domain/phpmyadmin/` to administer MariaDB. Sign in to phpMyAdmin with `DB_USER` and `DB_PASSWORD` from `.env` for the app database, or with `root` and `DB_ROOT_PASSWORD` for full database administration.
5. Sign in to the POS with `ADMIN_USERNAME` and `ADMIN_PASSWORD` from `.env`.

Caddy obtains public HTTPS certificates when the domain resolves to this server and ports 80/443 are reachable. Its local certificate for `localhost` may require trusting Caddy's local CA in your browser. MariaDB and phpMyAdmin do not publish host ports; both are reached through the internal Docker network and phpMyAdmin is reverse proxied by Caddy.

The initial admin account is created when the database is first initialized. Set its credentials before first startup. Changing `ADMIN_PASSWORD` later does not reset an existing account. MariaDB's named volume is also initialized only once: changing DB passwords in `.env` after startup does not rotate credentials stored in the existing database.

Admins can change their own password from Management → Admin account. If the admin password is forgotten, run this on the server from the project directory (replace `admin` with the admin username):

```sh
docker compose exec -it app node scripts/reset-admin-password.js admin
```

The script prompts for the new password without displaying it, hashes it, and updates that admin account in MariaDB. Sign in again with the new password.

## Access levels

- **Admin:** manage product categories, fish and pricing, upload fish images, set inventory in kilograms, review low and empty stock, adjust stock, generate/print barcode labels in bulk by category or date added, manage users, change their own password, and review sales with the dashboard, using Today, Week to date, Month to date, Year to date, or custom filters by category and cashier.
- **Shop Manager:** view the sales dashboard, add and view fish products, add and view inventory, and export overall sales or sales filtered by cashier as CSV or PDF.
- **Cashier:** Point of Sale plus a limited Management tab to add fish, view inventory, print labels, and export only their own sales as CSV or PDF. Cashiers cannot adjust stock, edit or remove products, manage categories or accounts, or open the admin dashboard. These permissions are enforced by the server.

Fish inventory is tracked in kilograms. Enter starting stock when adding a fish; completed sales subtract the sold weight transactionally. Existing fish receive 0 kg when the inventory migration runs, so enter their current stock in Management → Inventory. Cashier passwords must be at least 8 characters. Fish images are limited to 5 MB. MariaDB data and uploaded images use persistent Docker volumes named `fish_data` and `fish_uploads`.

## EAN-13 and UPC-A barcode scanner

Most USB scanners behave like a keyboard. Focus the barcode field on checkout, scan the EAN-13 or UPC-A label, then the scanner's Enter suffix adds the matching fish. You can also click **Add** after scanning. Weight is entered at checkout.

## Build and publish to Docker Hub

The included GitHub Actions workflow builds the app image and publishes it to Docker Hub on pushes to `main` and version tags (`v*.*.*`). In the GitHub repository settings, add these Actions secrets:

- `DOCKERHUB_USERNAME`: your Docker Hub username.
- `DOCKERHUB_TOKEN`: a Docker Hub access token with permission to push to the repository.

Create the Docker Hub repository `fish-market-pos`, push the project to GitHub's `main` branch, and create a version tag to publish a versioned image, for example:

```sh
git tag v1.0.0
git push origin v1.0.0
```

The app service uses `mikegemai101/fish-market-pos:latest` from Docker Hub by default. Set `APP_IMAGE` in `.env` to select another tag. Pull updates with `docker compose pull app && docker compose up -d`.

## Project prompt

See [PROMPT.md](PROMPT.md) for the reusable project brief.
