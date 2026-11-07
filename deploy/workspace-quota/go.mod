module github.com/cookerpapa/pi-cloud/workspace-quota

go 1.26.0

replace github.com/cookerpapa/pi-cloud/resource-metering => ../resource-metering

require (
	github.com/cookerpapa/pi-cloud/resource-metering v0.0.0
	github.com/google/uuid v1.6.0
	go.etcd.io/bbolt v1.4.3
)

require golang.org/x/sys v0.48.0 // indirect
