#!/bin/sh
# Idempotent store bootstrap. Runs as a Helm post-install/post-upgrade hook on every
# release, so every step must be safe to repeat.
set -eu
cd /var/www/html
WP="wp --user=$WP_ADMIN_USER"

echo "==> waiting for WordPress files (copied by the wordpress container on first boot)"
until [ -f wp-config.php ]; do sleep 3; done

echo "==> waiting for MariaDB"
until php -r '$m=@new mysqli(getenv("WORDPRESS_DB_HOST"),getenv("WORDPRESS_DB_USER"),getenv("WORDPRESS_DB_PASSWORD"),getenv("WORDPRESS_DB_NAME")); exit($m->connect_errno?1:0);'; do sleep 3; done

if ! wp core is-installed 2>/dev/null; then
  echo "==> installing WordPress"
  wp core install --url="$SITE_URL" --title="$SITE_TITLE" \
    --admin_user="$WP_ADMIN_USER" --admin_password="$WP_ADMIN_PASSWORD" \
    --admin_email="$WP_ADMIN_EMAIL" --skip-email
fi
wp option update timezone_string UTC
wp rewrite structure '/%postname%/'

echo "==> WooCommerce ($WC_VERSION)"
current=$(wp plugin get woocommerce --field=version 2>/dev/null || true)
if [ -z "$current" ]; then
  if [ "$WC_VERSION" = latest ]; then wp plugin install woocommerce
  else wp plugin install woocommerce --version="$WC_VERSION"; fi
elif [ "$WC_VERSION" != latest ] && [ "$current" != "$WC_VERSION" ]; then
  wp plugin install woocommerce --version="$WC_VERSION" --force   # pinned upgrade/downgrade
fi
wp plugin is-active woocommerce || wp plugin activate woocommerce
$WP wc update || true                                    # run pending WC DB migrations

wp theme is-installed storefront || wp theme install storefront
wp theme activate storefront

echo "==> store settings"
wp option update woocommerce_coming_soon no              # new stores start in "coming soon" mode
wp option update woocommerce_currency "$WC_CURRENCY"
wp option update woocommerce_default_country "$WC_COUNTRY"
wp option update woocommerce_ship_to_countries disabled  # no shipping zones needed for the demo
wp option update woocommerce_enable_guest_checkout yes
wp option update woocommerce_onboarding_profile '{"skipped":true}' --format=json
wp option update woocommerce_cod_settings '{"enabled":"yes","title":"Cash on delivery","description":"Pay with cash upon delivery.","instructions":"Pay with cash upon delivery.","enable_for_methods":[],"enable_for_virtual":"yes"}' --format=json
$WP wc tool run install_pages >/dev/null                  # creates Shop/Cart/Checkout only if missing

echo "==> REST API key for woo-mcp"
wp eval-file /scripts/ensure-api-key.php

if [ "$SAMPLE_PRODUCTS" = true ] && [ "$(wp post list --post_type=product --format=count)" = 0 ]; then
  echo "==> sample products"
  $WP wc product create --name="Urumi Hoodie" --regular_price=45.00 --status=publish
  $WP wc product create --name="Urumi Mug" --regular_price=12.50 --status=publish
  $WP wc product create --name="Sticker Pack" --regular_price=4.99 --status=publish
fi

echo "==> done: $SITE_URL"
