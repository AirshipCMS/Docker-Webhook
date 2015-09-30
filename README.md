# docker-webhook
Dockerfile for container that responds to docker webhook requests


usage:

```
docker run \
  -e FLEETCTL_ENDPOINT=${COREOS_PRIVATE_IPV4}:4001 \
  -e AUTH_TOKEN=yoursecretauthtokensetindockerwebhookurl \
  -e AIRSHIP_IDX=14 \
  -p 8411:8411 \
  airshipcms/docker-webhook
```
