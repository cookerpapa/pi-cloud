{{- define "pi-cloud-platform.name" -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "pi-cloud-platform.labels" -}}
app.kubernetes.io/name: pi-cloud
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | quote }}
{{- end -}}

{{- define "pi-cloud-platform.image" -}}
{{- printf "%s:%s" .repository .tag -}}
{{- end -}}

{{- define "pi-cloud-platform.secretMounts" -}}
- name: platform-secrets
  mountPath: /run/pi-cloud-secrets/database-url
  subPath: {{ .Values.external.database.secretKey }}
  readOnly: true
- name: platform-secrets
  mountPath: /run/pi-cloud-secrets/database-notification-url
  subPath: {{ .Values.external.database.notificationSecretKey }}
  readOnly: true
- name: platform-secrets
  mountPath: /run/pi-cloud-secrets/supervisor-enrollment-token
  subPath: supervisor-enrollment-token
  readOnly: true
- name: platform-secrets
  mountPath: /run/pi-cloud-secrets/supervisor-management-token
  subPath: supervisor-management-token
  readOnly: true
- name: platform-secrets
  mountPath: /run/pi-cloud-secrets/cube-egress-config-token
  subPath: cube-egress-config-token
  readOnly: true
- name: platform-secrets
  mountPath: /run/pi-cloud-secrets/workspace-service-token
  subPath: workspace-service-token
  readOnly: true
- name: platform-secrets
  mountPath: /run/pi-cloud-secrets/workspace-terminal-token
  subPath: workspace-terminal-token
  readOnly: true
- name: platform-secrets
  mountPath: /run/pi-cloud-secrets/metrics-token
  subPath: metrics-token
  readOnly: true
- name: platform-secrets
  mountPath: /run/pi-cloud-secrets/sandbox-control-token
  subPath: sandbox-control-token
  readOnly: true
- name: platform-secrets
  mountPath: /run/pi-cloud-secrets/cube-persistent-state-key
  subPath: cube-persistent-state-key
  readOnly: true
- name: platform-secrets
  mountPath: /run/pi-cloud-secrets/workspace-volume-gateway-token
  subPath: workspace-volume-gateway-token
  readOnly: true
- name: platform-secrets
  mountPath: /run/pi-cloud-secrets/cubesandbox-api-key
  subPath: cubesandbox-api-key
  readOnly: true
{{- if .Values.controlPlane.sourceControl.github.enabled }}
- name: platform-secrets
  mountPath: /run/pi-cloud-secrets/github-app-private-key.pem
  subPath: {{ .Values.controlPlane.sourceControl.github.privateKeySecretKey }}
  readOnly: true
- name: platform-secrets
  mountPath: /run/pi-cloud-secrets/github-webhook-secret
  subPath: {{ .Values.controlPlane.sourceControl.github.webhookSecretKey }}
  readOnly: true
{{- end }}
{{- if .Values.controlPlane.sourceControl.gitlab.enabled }}
- name: platform-secrets
  mountPath: /run/pi-cloud-secrets/source-control-credential-master-key
  subPath: {{ .Values.controlPlane.sourceControl.gitlab.credentialMasterKeySecretKey }}
  readOnly: true
{{- end }}
{{- end -}}
