FROM mhart/alpine-node:0.12

MAINTAINER Jon Borgonia "jon@gomagames.com"

# fleet version
ENV VERSION 0.11.5

# build git
RUN apk --update add git

ADD webhook.js /srv/index.js
ADD package.json /srv/package.json

RUN cd /srv && npm install
RUN npm -g install forever

# build fleet
RUN apk add --update curl && \
    curl -LOks https://github.com/coreos/fleet/releases/download/v${VERSION}/fleet-v${VERSION}-linux-amd64.tar.gz && \
    tar zxvf fleet-v${VERSION}-linux-amd64.tar.gz && \
    cp fleet-v${VERSION}-linux-amd64/fleetctl /bin/fleetctl && \
    rm -rf fleet-v* && \
    chmod +x /bin/fleetctl

# url of fleet
# FLEETCTL_ENDPOINT=${COREOS_PRIVATE_IPV4}
# FLEETCTL_ENDPOINT=${COREOS_PRIVATE_IPV4}:4001
ENV FLEETCTL_ENDPOINT 127.0.0.1:4001

# secret auth token manually generated for docker webhook
# http://yourfleet.com:8411/YOUR_SECRET_AUTH_TOKEN
ENV AUTH_TOKEN YOUR_SECRET

# etcd path to watch for fleetctl to reload when webhook is triggered
# example: /nginx
ENV WATCH_ETCD CHOOSE_ETCD_PATH

# etcd path to watch for fleetctl to reload when webhook is triggered
# example: /nginx/*
ENV ETCD_UNITS CHOOSE_ETCD_UNITS

# repo name of docker webhook
ENV REPO_NAME='_/_'

# install confd and watch script
ADD bin/* /usr/local/bin/
RUN chmod +x /usr/local/bin/*

# add confd templates
ADD confd /etc/confd

ADD docker-entrypoint.sh /

EXPOSE 8411

WORKDIR /srv

ENTRYPOINT ["/bin/sh","/docker-entrypoint.sh"]

CMD ["/bin/sh","/usr/local/bin/confd-watch"]
