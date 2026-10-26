#!/bin/bash
set -euo pipefail
: "${PI_CLOUD_ANDROID_VSOCK_CID:?A device-specific vsock CID is required}"
export ANDROID_HOST_OUT=/cvd ANDROID_PRODUCT_OUT=/data/images
mkdir -p /data/images /data/instances /data/assembly
# One persistent userdata owner. Never overwrite an already initialized device.
if [ ! -f /data/.initialized ]; then
  if [ -n "$(ls -A /data/images)" ]; then
    echo 'Partial Android initialization requires operator reconciliation' >&2
    exit 1
  fi
  cp --sparse=always /source/*.img /data/images/
  cp /source/android-info.txt /data/images/
  touch /data/.initialized
fi
service cuttlefish-host-resources start
# These rules exist only in the Pod's network namespace. Guest interfaces may
# reach the HTTP(S) egress proxy, DHCP and DNS, never trusted execution services.
for firewall in iptables ip6tables; do
  "$firewall" -w -N PI_ANDROID_INPUT 2>/dev/null || true
  "$firewall" -w -F PI_ANDROID_INPUT
  "$firewall" -w -A PI_ANDROID_INPUT -p tcp --dport 3128 -j ACCEPT
  "$firewall" -w -A PI_ANDROID_INPUT -p udp --dport 67 -j ACCEPT
  "$firewall" -w -A PI_ANDROID_INPUT -p udp --dport 53 -j ACCEPT
  "$firewall" -w -A PI_ANDROID_INPUT -p tcp --dport 53 -j ACCEPT
  "$firewall" -w -A PI_ANDROID_INPUT -j DROP
  "$firewall" -w -C INPUT -i cvd+ -j PI_ANDROID_INPUT 2>/dev/null || "$firewall" -w -I INPUT 1 -i cvd+ -j PI_ANDROID_INPUT
  "$firewall" -w -C FORWARD -i cvd+ -j DROP 2>/dev/null || "$firewall" -w -I FORWARD 1 -i cvd+ -j DROP
  "$firewall" -w -C FORWARD -o cvd+ -j DROP 2>/dev/null || "$firewall" -w -I FORWARD 1 -o cvd+ -j DROP
done
stop() { /cvd/bin/stop_cvd || true; }
trap stop EXIT
trap 'exit 0' TERM INT
/cvd/bin/launch_cvd --system_image_dir=/data/images --instance_dir=/data/instances --assembly_dir=/data/assembly \
  --memory_mb=3072 --cpus=2 --gpu_mode=guest_swiftshader --enable_sandbox=false \
  --vhost_user_vsock=false --vsock_guest_cid="$PI_CLOUD_ANDROID_VSOCK_CID" \
  --enable_audio=false --start_webrtc=true --report_anonymous_usage_stats=n --daemon
/cvd/bin/adb connect 127.0.0.1:6520
/cvd/bin/adb -s 127.0.0.1:6520 wait-for-device
/cvd/bin/adb -s 127.0.0.1:6520 shell settings put global http_proxy 192.168.97.1:3128
# Fresh-device setup only; an operator/user lock is never reset on a restart.
if [ ! -f /data/.first-boot-configured ]; then
  /cvd/bin/adb -s 127.0.0.1:6520 shell settings put global stay_on_while_plugged_in 7
  /cvd/bin/adb -s 127.0.0.1:6520 shell wm dismiss-keyguard
  touch /data/.first-boot-configured
fi
while /cvd/bin/adb -s 127.0.0.1:6520 shell getprop sys.boot_completed | tr -d '\r' | grep -qx 1; do
  sleep 10 & wait $!
done
exit 1
