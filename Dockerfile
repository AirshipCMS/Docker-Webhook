FROM mhart/alpine-node:0.12

MAINTAINER Jon Borgonia "jon@gomagames.com"

# fleet version
ENV VERSION 0.11.5

# build git
RUN apk --update add git

ADD webhook.js /srv/index.js
ADD package.json /srv/package.json

RUN cd /srv && npm install

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

# service unit names (array) for fleetctl to reload when webhook is triggered
ENV UPDATE_UNITS ['nginx@1']

# repo name of docker webhook
ENV REPO_NAME='_/_'

# install confd and watch script
ADD bin/* /usr/local/bin/
RUN chmod +x /usr/local/bin/*

# add confd templates
ADD confd /etc/confd

EXPOSE 8411

WORKDIR /srv

CMD ["/usr/local/bin/confd-watch"]
