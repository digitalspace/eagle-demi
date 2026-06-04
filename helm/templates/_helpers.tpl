{{/*
Expand the chart name.
*/}}
{{- define "eagle-demi.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Full release name.
*/}}
{{- define "eagle-demi.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{/*
Chart label.
*/}}
{{- define "eagle-demi.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels.
*/}}
{{- define "eagle-demi.labels" -}}
helm.sh/chart: {{ include "eagle-demi.chart" . }}
{{ include "eagle-demi.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app: eagle-epic
{{- end }}

{{/*
Selector labels.
*/}}
{{- define "eagle-demi.selectorLabels" -}}
app.kubernetes.io/name: {{ include "eagle-demi.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}
