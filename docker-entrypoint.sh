#!/bin/sh

sed -i "s,\${WATCH_ETCD},${WATCH_ETCD}," /etc/confd/conf.d/units.toml

exec "$@"
