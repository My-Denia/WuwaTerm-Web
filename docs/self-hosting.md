# Self-host WuwaTerm Web

The private runtime serves the same lookup, translation, review and manuscript
workbench as the public site. It requires Node 24.22.1, npm 11.6.2, a compatible
WuwaTerm Core HTTP API with an issued device token and `GET /v1/auth/status`
support, and an HTTPS reverse proxy that authenticates visitors. The API and
its dictionary are installed and managed separately; this repository does not
include a dictionary or an API service. The device needs both `meta` and
`translate` scopes. Translation also requires the Core API's own model
configuration.

The reverse proxy must authenticate every request and overwrite the
`X-WuwaTerm-Edge` request header with the shared edge secret. Never let a
visitor choose that header or access the Web listener directly from the
network. TLS is required for the secure session cookie. The Web process checks
the device with the Core API when admitting requests; a revoked device stops
working. These checks have a separate per-device Core probe allowance (120 per
minute by default) and share its authentication concurrency limit. They do not
spend the Core business request allowance. An older Core API without this status
endpoint cannot serve the private workbench; access remains closed.

## Build and configure

Install the locked dependencies, then build. The prefix is fixed into the
browser bundle at build time; leave it empty for the origin root. Rebuild when
changing it. It must be empty or a leading slash followed by one or more
slash-separated letters, digits, underscores or hyphens, with no trailing slash.

```sh
npm ci --no-audit
NEXT_PUBLIC_WUWATERM_BASE_PATH=/private npm run build:selfhost
```

The command produces `.next-selfhost/standalone/`, including the browser assets
and `public/`. The regular `npm run build` remains the public Sites build and
has separate output. The standalone directory can be copied to another machine
with the same supported Node runtime. Keep its files together.

Create a private environment file outside the repository with permissions that
allow only the service account to read it. Replace every placeholder; use the
same edge secret in this file and in the reverse proxy. The secret must be
32–128 letters, digits, underscores or hyphens. The URL below is an example,
not a service endpoint.

```text
WUWATERM_RUNTIME_MODE=selfhost
WUWATERM_WEB_ORIGIN=https://web.example.invalid
WUWATERM_WEB_EDGE_SECRET=REPLACE_WITH_A_RANDOM_EDGE_SECRET_OF_AT_LEAST_32_CHARACTERS
WUWATERM_WEB_BASE_PATH=/private
WUWATERM_API_BASE_URL=http://127.0.0.1:18789/
WUWATERM_SITE_DEVICE_TOKEN=REPLACE_WITH_CORE_DEVICE_TOKEN
WUWATERM_TRANSLATION_ENABLED=true
WUWATERM_LOCAL_DB_PATH=/var/lib/wuwaterm-web/pool.sqlite3
```

`WUWATERM_WEB_ORIGIN` is the external HTTPS origin only, without the prefix or
trailing slash. `WUWATERM_WEB_BASE_PATH`, if set, must equal the build prefix.
The example API uses same-host loopback HTTP. For a protected HTTPS API, set
`WUWATERM_API_BASE_URL` to its exact base URL and
`WUWATERM_API_ALLOWED_HOST` to its lowercase hostname. URL credentials, query
strings, fragments and redirects are rejected. Keep both the edge secret and
device token on the server; they are not browser configuration. Environment
files and container configuration remain readable to the host administrator.

The DB path must be absolute, in an existing directory writable by the service
account. The runtime creates a new mode-0600 SQLite file, or opens its own
previously initialized database. It refuses unrelated databases. Do not point
it at the Core dictionary or device store. Startup fails when configuration or
the admission database is invalid.

After loading the environment into the service process, start it on loopback:

```sh
npm run start:selfhost
```

`PORT` defaults to 3000. `WUWATERM_WEB_BIND` defaults to `127.0.0.1`; use a
different bind only with equivalent network isolation. The copied standalone
directory may instead be started there with `HOSTNAME=127.0.0.1 PORT=3000 node
server.js` after loading the same environment.

## Docker on the API host

On Linux, host networking lets Web reach a Core API already bound to loopback;
it does not require exposing the API on all interfaces. Build from this source
tree and select the prefix at build time:

```sh
docker build --build-arg NEXT_PUBLIC_WUWATERM_BASE_PATH=/private -t wuwaterm-web:local .
docker run --network host --user "$(id -u):$(id -g)" \
  --env-file /secure/path/wuwaterm-web.env \
  --env HOSTNAME=127.0.0.1 --env PORT=3000 \
  --mount type=bind,src=/absolute/path/to/web-data,dst=/var/lib/wuwaterm-web \
  wuwaterm-web:local
```

Prepare a private, writable data directory before starting the container, and
put the container path `/var/lib/wuwaterm-web/pool.sqlite3` in the environment
file. The image runs as a non-root user by default; the example uses the host
user's numeric ID so it can write its own bind mount. The data directory and
environment file are not included in the image or build context.

## Reverse-proxy example

Configure TLS and the proxy's own authentication first. For example, an nginx
HTTPS server may route the `/private` build as follows. The included file must
be readable only by the proxy administrator and contain exactly a
`proxy_set_header X-WuwaTerm-Edge "<the shared edge secret>";` directive. The
directive replaces any client-supplied value. Protect the password file and
provision credentials using the proxy's normal administration procedure.

```nginx
location ~ ^/private(?:/|$) {
    auth_basic "Private workbench";
    auth_basic_user_file /etc/nginx/private-workbench-users;
    include /etc/nginx/private-workbench-edge.conf;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_pass http://127.0.0.1:3000;
}
```

The proxy must forward the prefix unchanged and apply authentication and the
edge-header replacement to pages, API routes and static assets alike. For a
root build, use an equivalent authenticated `location /` instead. Do not
serve the generated static directory directly from an unauthenticated route.

## Limits, sessions and data

The local SQLite database stores aggregate admission windows and counts, not
manuscripts. Defaults are 6 upstream requests per minute, at most one per second;
one translation per minute; and per UTC day 240 term lookups, 30 translations,
12,000 translation input characters, 60 metadata requests and 60 reviews.
Admissions count even if the upstream request later fails. Configure positive
integer overrides before starting the process:

```text
WUWATERM_LOCAL_LIMIT_UPSTREAM_PER_MINUTE
WUWATERM_LOCAL_LIMIT_TRANSLATIONS_PER_MINUTE
WUWATERM_LOCAL_LIMIT_TERMS_PER_DAY
WUWATERM_LOCAL_LIMIT_TRANSLATIONS_PER_DAY
WUWATERM_LOCAL_LIMIT_CHARACTERS_PER_DAY
WUWATERM_LOCAL_LIMIT_META_PER_DAY
WUWATERM_LOCAL_LIMIT_REVIEWS_PER_DAY
```

The Web session is an opaque, Secure, HttpOnly, SameSite=Strict cookie scoped to
the build prefix. It expires after 900 seconds by default; set
`WUWATERM_WEB_SESSION_TTL_SECONDS` to a positive number up to 86400 to change
it. Sessions are held in memory and end on restart. The language preference is
a separate cookie. Your proxy, Core API, operating system and model provider
may retain technical data under their own policies.

This is a new local admission database; public D1 quota and the legacy private
renderer are not migrated into it. Existing manuscript files remain usable in
the workbench. For a consistent quota backup, stop the Web process before
copying its SQLite database, and restore it only while the process is stopped;
retain its owner-only permissions. Keep the Core API's dictionary, device store
and credentials under their own backup procedures.
