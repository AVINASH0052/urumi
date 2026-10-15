{{- define "platform.host" -}}{{ .Values.host | default (printf "app.%s" .Values.global.domain) }}{{- end }}
{{- define "platform.url" -}}{{ if .Values.ingress.tls.enabled }}https{{ else }}http{{ end }}://{{ include "platform.host" . }}{{- end }}
{{- define "platform.secretName" -}}{{ .Values.existingSecret | default (printf "%s-gateway" .Release.Name) }}{{- end }}
{{- define "platform.storeSecret" -}}{{ .Values.storeSecret | default (printf "%s-store" .Release.Name) }}{{- end }}

{{- define "platform.labels" -}}
app.kubernetes.io/name: platform
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end }}

{{/* include "platform.selector" (list . "gateway") */}}
{{- define "platform.selector" -}}
app.kubernetes.io/name: platform
app.kubernetes.io/instance: {{ (index . 0).Release.Name }}
app.kubernetes.io/component: {{ index . 1 }}
{{- end }}

{{/* include "platform.secretEnv" (list . "ENV_NAME" "secret-name" "KEY") */}}
{{- define "platform.secretEnv" -}}
- name: {{ index . 1 }}
  valueFrom:
    secretKeyRef:
      name: {{ index . 2 }}
      key: {{ index . 3 }}
{{- end }}

{{- define "platform.containerSecurity" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities: { drop: [ALL] }
{{- end }}
{{- define "platform.podSecurity" -}}
runAsNonRoot: true
runAsUser: 1000
seccompProfile: { type: RuntimeDefault }
{{- end }}
