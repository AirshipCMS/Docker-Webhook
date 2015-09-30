# docker-webhook
Dockerfile for container that responds to docker webhook requests


usage:

```
docker run \
  -e FLEETCTL_ENDPOINT=${COREOS_PRIVATE_IPV4}:4001 \
  -e AUTH_TOKEN=yoursecretauthtokensetindockerwebhookurl \
  -e UPDATE_UNITS=['nginx@1','nginx@2'] \
  -e REPO_NAME='_/nginx' \
  -p 8411:8411 \
  airshipcms/docker-webhook
```
this will respond to docker webhook requests for the repo '_/nginx' and update the 2 fleet units runnig in the cluster.

the docker webhook url should be set to https://yourdomain.com/yoursecretauthtokensetindockerwebhookurl

example webhook payload

```
{
  "push_data":{
    "pushed_at":1385141110,
    "images":[
      "imagehash1",
      "imagehash2",
      "imagehash3"
    ],
    "pusher":"username"
  },
  "repository":{
    "status":"Active",
    "description":"my docker repo that does cool things",
    "is_trusted":false,
    "full_description":"This is my full description",
    "repo_url":"https://registry.hub.docker.com/u/_/nginx/",
    "owner":"username",
    "is_official":false,
    "is_private":false,
    "name":"reponame",
    "namespace":"username",
    "star_count":1,
    "comment_count":1,
    "date_created":1370174400,
    "dockerfile":"my full dockerfile is listed here",
    "repo_name":"_/nginx"
  }
}
```
