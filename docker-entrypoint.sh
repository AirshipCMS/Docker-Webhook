#!/bin/sh

sed -i "s,\${WATCH_UNITS},${WATCH_UNITS}," /etc/confd/conf.d/units.toml
