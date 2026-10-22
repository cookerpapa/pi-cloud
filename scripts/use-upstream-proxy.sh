# Source this file from a host shell. Never evaluate the proxy file as shell code.
pi_cloud_proxy_source="$(dirname "${BASH_SOURCE[0]}")/../deploy/production/runtime/upstream-proxy"
if [ -n "${PI_CLOUD_RUNTIME_DIRECTORY:-}" ]; then
  case "$PI_CLOUD_RUNTIME_DIRECTORY" in
    /*) pi_cloud_proxy_source="${PI_CLOUD_RUNTIME_DIRECTORY}/upstream-proxy" ;;
    *) pi_cloud_proxy_source="$(dirname "${BASH_SOURCE[0]}")/../${PI_CLOUD_RUNTIME_DIRECTORY}/upstream-proxy" ;;
  esac
fi
if [ -r "$pi_cloud_proxy_source" ]; then
  IFS= read -r pi_cloud_proxy_value < "$pi_cloud_proxy_source" || [ -n "$pi_cloud_proxy_value" ]
  export HTTP_PROXY="$pi_cloud_proxy_value" HTTPS_PROXY="$pi_cloud_proxy_value"
  export http_proxy="$pi_cloud_proxy_value" https_proxy="$pi_cloud_proxy_value"
  export ALL_PROXY="$pi_cloud_proxy_value" all_proxy="$pi_cloud_proxy_value"
fi
unset pi_cloud_proxy_source pi_cloud_proxy_value
