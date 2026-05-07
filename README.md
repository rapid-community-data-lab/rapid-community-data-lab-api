# rapid-community-data-lab-api

Implementation of [Arocapi](https://www.npmjs.com/package/arocapi) for the
Rapid Community Data Lab — a REST API built with TypeScript, Fastify, Prisma,
PostgreSQL and OpenSearch.

The service ships its own Dockerfile and docker-compose stack so it can be
deployed independently of the [`oni-ui`](../oni-ui) frontend. Both projects
join a single shared Docker network (`rapid-community-data-lab`) so nginx in
oni-ui can resolve this backend by Docker DNS (hostname `api`). The same
arrangement maps cleanly to Kubernetes / K3s on OpenStack via GitLab CI/CD,
where the backend URL becomes a runtime env var on the nginx pod.

---

## 1. Run locally with Docker (recommended)

### 1.1. Prerequisites

- Docker 24+ and Docker Compose v2
- A `.env` file in this directory (a working sample is committed; review the
  `DB_*`, `TOKEN_ADMIN`, and `OPENSEARCH_JAVA_OPTIONS` values).

### 1.2. Create the shared Docker network (one-time)

```bash
docker network create rapid-community-data-lab
```

This network is referenced as `external: true` by both this project's compose
file and `oni-ui/docker/docker-compose.yml`.

### 1.3. Build and start the API stack

```bash
cd /Users/am/uq/rapid-community-data-lab-api
docker compose build           # builds both the api image and the local opensearch image
docker compose up -d
```

This starts three containers attached to the shared network:

| Service      | Container name                              | Hostname     | Host port |
|--------------|---------------------------------------------|--------------|-----------|
| Postgres     | `db`           | `db`         | 5432      |
| OpenSearch   | `opensearch`   | `opensearch` | 9200, 9300 |
| API (this)   | `api`              | `api`        | 8080      |

The `api` container's entrypoint waits for Postgres + OpenSearch, runs
`prisma db push` to sync the schema, then starts the Fastify server.

The `opensearch` image is built locally from `docker/opensearch/Dockerfile`
and removes the unused `opensearch-performance-analyzer` plugin (its config
files are missing from the upstream 3.5.0 image and produce noisy errors).

### 1.4. Verify

```bash
curl -s http://localhost:8080/version
```

### 1.5. Index the bundled test data

Export `TOKEN_ADMIN` from `.env` first (the value is quoted in the file):

```bash
export TOKEN_ADMIN=$(grep ^TOKEN_ADMIN .env | cut -d= -f2- | tr -d '"')
curl -L -X POST -H "Authorization: Bearer ${TOKEN_ADMIN}" \
  http://localhost:8080/admin/index/
```

Indexing runs asynchronously in the background. To watch progress:

```bash
docker compose logs -f api | grep -E 'Indexing|level":50'
```

You should see `Indexing arcp://...` lines for each bundled crate. When
indexing completes, the entity count is available via:

```bash
curl -s 'http://localhost:8080/entities?limit=1' | head -c 80
# -> {"total":6194,...
```

### 1.6. Run the oni-ui frontend against this API

```bash
cd /Users/am/uq/oni-ui
docker compose -f docker/docker-compose.yml up -d --build
# Open http://localhost:8081  -- nginx proxies /api -> http://api:8080
```

---

## 2. Run locally without Docker (developer mode)

For an inner-loop dev workflow with `--watch` reload:

```bash
cd /Users/am/uq/rapid-community-data-lab-api
docker compose up -d db opensearch    # only the data services
npm install
npm run db:sync                       # prisma generate + db push
npm run dev                           # node --watch src/index.ts
```

---

## 3. Runtime configuration

All runtime knobs are environment variables. The Docker image reads them
directly (no `.env` file needed inside the container).

| Variable                              | Default                                   | Notes |
|---------------------------------------|-------------------------------------------|-------|
| `RAPID_COMMUNITY_DATA_LAB_API_PORT`   | `8080`                                    | Listen port. |
| `DATABASE_URL`                        | (required)                                | Postgres connection string. |
| `OPENSEARCH_URL`                      | `http://localhost:9200`                   | OpenSearch endpoint. |
| `TOKEN_ADMIN`                         | `1234-1234-1234-1234`                     | Bearer token for `/admin/*`. |
| `LOG_LEVEL`                           | `info` (`debug` in dev)                   | Pino log level. |
| `OCFL_PATH`                           | `./.ocfl/data`                            | OCFL repository root. |
| `OCFL_SCRATCH`                        | `./.ocfl/scratch`                         | OCFL working dir. |
| `RAPID_COMMUNITY_DATA_LAB_API_CONFIG_PATH` | (unset)                              | Optional override config file. |

---

## 4. Kubernetes / K3s on OpenStack via GitLab CI/CD

Because the image is fully env-var driven and listens on a single port,
deploying to K3s is straightforward:

- Build/push the API image from `Dockerfile` in your GitLab CI pipeline.
- Create a `Deployment` exposing port `8080` and a matching `Service` named
  e.g. `rapid-community-data-lab-api`.
- Inject `DATABASE_URL`, `OPENSEARCH_URL`, `TOKEN_ADMIN` etc. as `Secret` /
  `ConfigMap` env vars on the pod.
- In the oni-ui Deployment, set `BACKEND_URL` to the in-cluster service URL,
  for example:

  ```yaml
  env:
    - name: BACKEND_URL
      value: "http://rapid-community-data-lab-api.<namespace>.svc.cluster.local:8080"
  ```

  oni-ui's nginx renders that value into `default.conf` at startup
  (`/api/*` → `${BACKEND_URL}/*`), so the frontend image is environment-agnostic.

---

## 5. Tests

```bash
# data services must be up first
docker compose up -d db opensearch
npm test     # NODE_ENV=test prisma migrate reset -f && vitest run
```
