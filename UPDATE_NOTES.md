## Temporary notes

_cause the night is late, and sanity is slipping along with my ram_


## Update to new docker-webhook

###  update docker-webhook unit env vars

remove : REPORT_VERSION

update : WATCH_ETCD and ETCD_UNITS => /airship/rolling_updates/_ _ _


### update discovery units

must report units to 2 places now,

    /airship/rolling_updates/api
    /airship/rolling_updates/static

      etcdctl set /airship/app/%i \'{"unit": "%N", "type": "api", "host": "%H", "ipv4_addr": "${COREOS_PRIVATE_IPV4}", "port": 389%i}\' --ttl 30; \

where:
  type is one of ["api", "nginx", "static"]
  port is either
    ["api", "static"] => port
    ["drone"] => docker container name


