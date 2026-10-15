<?php
// Upsert the WooCommerce REST key used by woo-mcp from the Kubernetes Secret, so nobody
// has to copy keys out of WP admin. WC stores the consumer key as an HMAC hash.
global $wpdb;
$ck   = getenv('WC_CONSUMER_KEY');
$cs   = getenv('WC_CONSUMER_SECRET');
$user = get_user_by('login', getenv('WP_ADMIN_USER'));
if (!$ck || !$cs || !$user) { WP_CLI::error('missing WC key env or admin user'); }

$table = $wpdb->prefix . 'woocommerce_api_keys';
$row = [
  'user_id'         => $user->ID,
  'description'     => 'mcp-gateway',
  'permissions'     => 'read_write',
  'consumer_key'    => wc_api_hash($ck),
  'consumer_secret' => $cs,
  'truncated_key'   => substr($ck, -7),
];
$id = $wpdb->get_var($wpdb->prepare("SELECT key_id FROM $table WHERE description = %s", 'mcp-gateway'));
$ok = $id ? $wpdb->update($table, $row, ['key_id' => $id]) : $wpdb->insert($table, $row);
if ($ok === false) { WP_CLI::error($wpdb->last_error); }
WP_CLI::success('WooCommerce API key in place (…' . $row['truncated_key'] . ')');
