# Deploying to AWS EC2

Pushing to `main` builds a Docker image, publishes it to GHCR, and restarts the
container on the EC2 box. `.github/workflows/deploy.yml` is the whole pipeline;
`docker-compose.prod.yml` is what actually runs on the server.

## The infrastructure

| Thing | Value |
|---|---|
| Region | `ap-south-1` (Mumbai) |
| Instance | `D2D` — `t3.small`, Amazon Linux 2023, 20 GB gp3 (encrypted) |
| Elastic IP | `35.154.20.8` — fixed, survives stop/start |
| Security group | `D2D-sg` — inbound 22, 80, 443 |
| Instance role | `D2D-ec2-role` — SSM access, so you can get a shell without SSH |
| App directory | `/opt/d2d` on the box (`docker-compose.prod.yml` + `.env`) |
| Image | `ghcr.io/sanjoyt2/aipm-test`, tagged with the commit SHA |

Postgres is **not** on this box — the app points at the managed cloud database via
`DATABASE_URL`. The schema self-creates on boot (`CREATE TABLE IF NOT EXISTS`), so
there is no migration step.

## Required secrets

Set under Settings → Secrets and variables → Actions. `EC2_HOST` and `EC2_SSH_KEY`
are already configured.

| Secret | Required? | Notes |
|---|---|---|
| `EC2_HOST` | set | Elastic IP of the box |
| `EC2_SSH_KEY` | set | Private half of the `aipm-test-deploy` key pair |
| `DATABASE_URL` | **yes** | Managed Postgres connection string. TLS is auto-detected for non-local hosts. |
| `OPENAI_API_KEY` | no | Omit to run the LLM gateway in stub mode |
| `OPERATOR_KEY` | no | Needed for operator/coach actions; they return 503 in production without it |
| `WA_API_TOKEN`, `WA_API_BASE`, `WA_ORIGIN_WEBSITE`, `WA_WEBHOOK_SECRET` | no | 11za WhatsApp; omit for outbound stub mode |

Optional repo *variables* `MODEL_FAST` / `MODEL_DEEP` override the model tiers
(defaults `gpt-4o-mini` / `gpt-4o`).

The workflow renders these into `/opt/d2d/.env` on every deploy, so that file is
derived state — edit the secrets, not the file.

## Operating it

Deploy is automatic on push to `main`, or run the workflow manually:

```bash
gh workflow run deploy.yml --repo SanjoyT2/AIPM-test
```

Get a shell without SSH keys or an open port:

```bash
aws ssm start-session --target i-0525e1f26e0c1fb6b --region ap-south-1
```

Tail the app logs:

```bash
ssh ec2-user@35.154.20.8 'docker compose -f /opt/d2d/docker-compose.prod.yml logs -f api'
```

To roll back, re-run an older successful workflow — images are pinned per commit SHA,
so the previous deploy is still in the registry.

## Known gaps

- **Plain HTTP.** Port 80 only; 443 is open in the security group but nothing terminates
  TLS yet. Point a domain at the Elastic IP and add Caddy or an ALB to get certificates.
- **Port 22 is open to the internet** so GitHub-hosted runners can reach it (their IP
  ranges are large and rotate). Auth is key-only. Tightening this means either a
  self-hosted runner or switching the deploy to SSM Send-Command.
- **The host key is trusted on first use** (`ssh-keyscan` in the workflow) rather than
  pinned to a known fingerprint.
