# OpenHands note

OpenHands uses Docker as its sandbox provider. That means this compose service mounts
/var/run/docker.sock. Treat the OpenHands UI as a trusted local application.
Do not expose it to an untrusted LAN without adding authentication/network controls.
