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
  mountPath: /run/pi-cloud-secrets/model-credential-master-key
  subPath: model-credential-master-key
  readOnly: true
- name: platform-secrets
  mountPath: /run/pi-cloud-secrets/cube-egress-config-token
  subPath: cube-egress-config-token
  readOnly: true
- name: platform-secrets
  mountPath: /run/pi-cloud-secrets/sandbox-materializer-token
  subPath: sandbox-materializer-token
  readOnly: true
- name: platform-secrets
  mountPath: /run/pi-cloud-secrets/workspace-terminal-token
  subPath: workspace-terminal-token
  readOnly: true
- name: platform-secrets
  mountPath: /run/pi-cloud-secrets/metrics-token
  subPath: metrics-token
  readOnly: true
{{- if .Values.controlPlane.authentication.gitlab.enabled }}
- name: platform-secrets
  mountPath: /run/pi-cloud-secrets/gitlab-oidc-client-secret
  subPath: {{ .Values.controlPlane.authentication.gitlab.clientSecretSecretKey }}
  readOnly: true
{{- end }}
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
