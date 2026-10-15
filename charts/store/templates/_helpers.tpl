{{- define "store.fullname" -}}{{ .Release.Name }}{{- end }}

{{- define "store.host" -}}
{{- .Values.host | default (printf "store.%s" .Values.global.domain) -}}
{{- end }}

{{- define "store.url" -}}
{{- if .Values.ingress.tls.enabled }}https{{ else }}http{{ end }}://{{ include "store.host" . }}
{{- end }}

{{- define "store.secretName" -}}
{{- .Values.existingSecret | default (printf "%s-store" (include "store.fullname" .)) -}}
{{- end }}

{{- define "store.labels" -}}
app.kubernetes.io/name: store
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end }}

{{/* usage: include "store.selector" (list . "mariadb") */}}
{{- define "store.selector" -}}
app.kubernetes.io/name: store
app.kubernetes.io/instance: {{ (index . 0).Release.Name }}
app.kubernetes.io/component: {{ index . 1 }}
{{- end }}

{{- define "store.secretEnv" -}}
- name: {{ index . 1 }}
  valueFrom:
    secretKeyRef:
      name: {{ include "store.secretName" (index . 0) }}
      key: {{ index . 2 }}
{{- end }}

{{/*
Env shared by the WordPress container and the setup Job. The official image's
wp-config.php reads these at runtime, so both must see identical values.
The X-Forwarded-Proto line is the standard "WP behind a TLS proxy" snippet; it also lets
woo-mcp use WooCommerce Basic auth over in-cluster HTTP (see PLAN.md §4.1).
*/}}
{{- define "store.wpEnv" -}}
- name: WORDPRESS_DB_HOST
  value: {{ include "store.fullname" . }}-mariadb
- name: WORDPRESS_DB_NAME
  value: {{ .Values.mariadb.database | quote }}
- name: WORDPRESS_DB_USER
  value: {{ .Values.mariadb.user | quote }}
{{ include "store.secretEnv" (list . "WORDPRESS_DB_PASSWORD" "MARIADB_PASSWORD") }}
- name: WORDPRESS_CONFIG_EXTRA
  value: |
    define('WP_HOME', '{{ include "store.url" . }}');
    define('WP_SITEURL', '{{ include "store.url" . }}');
    define('DISALLOW_FILE_EDIT', true);
    if (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https') { $_SERVER['HTTPS'] = 'on'; }
{{- end }}
