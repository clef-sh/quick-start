# Clef quick start

A ~10-minute, copy-paste tutorial that takes you from an empty directory to a fully working [Clef](https://clef.sh) setup, then deploys the production secrets to AWS Secrets Manager via the [`@clef-sh/cdk`](https://www.npmjs.com/package/@clef-sh/cdk) constructs.

By the end, you'll have:

- A `clef.yaml` with two namespaces (`database`, `payments`) across two environments (`dev`, `production`)
- All four matrix cells populated with demo secrets, encrypted with [SOPS](https://github.com/getsops/sops)
- A service identity (`app`) whose `production` envelope is protected by AWS KMS
- A CloudFormation stack with three `ClefSecret`s, each holding a Clef-managed value in AWS Secrets Manager — readable by your app via the standard ASM SDK, with no Clef agent at runtime

Steps 1–3 work fully offline. Steps 4–5 deploy real AWS resources and require working AWS credentials.

## Prerequisites

- **Node.js 20+**
- **AWS account + credentials** for steps 4–5 only. Standard SDK resolution applies (`AWS_PROFILE`, env vars, SSO, etc.). The KMS key, an unwrap Lambda, and three Secrets Manager secrets will be created in the account/region your credentials resolve to. All resources are tagged `clef-quick-start` so you can find and remove them.
- **Git** — Clef is git-native, and the tutorial commits the initial state after `clef init` so you can see exactly what each subsequent step adds. Cloning this repo (per the setup step below) gives you a git working tree already.
- **Shell** — commands below are written for a POSIX shell (macOS/Linux Terminal, WSL, or Git Bash on Windows). PowerShell works too; the only block that needs a different syntax is the variable derivation in step 4, where a PowerShell variant is shown alongside.

## Setup

```bash
git clone https://github.com/clef-sh/quick-start.git
cd quick-start
npm install
```

`npm install` puts the `clef` CLI under `node_modules/.bin`. The tutorial uses `npx clef`, but you can also install it globally with `npm i -g @clef-sh/cli` if you'd rather drop the prefix.

Verify the install:

```bash
npx clef doctor
```

You should see green checks for `node`, `sops`, and `git` (if present).

---

## Step 1 — Initialise Clef

Create the manifest and the encrypted matrix in one shot, using the [age](https://github.com/FiloSottile/age) backend (no AWS account needed yet):

```bash
npx clef init \
  --namespaces database,payments \
  --environments dev,production \
  --backend age \
  --non-interactive
```

What just happened:

- `clef.yaml` now declares your namespaces, environments, and the age recipient that owns this repo.
- `.clef/config.yaml` records the local age private key location (stored in your OS keychain by default).
- `secrets/database/{dev,production}.enc.yaml` and `secrets/payments/{dev,production}.enc.yaml` were created — each one is a valid SOPS file with no keys yet.
- `.clefignore` and `.gitattributes` were written so the SOPS merge driver picks up `*.enc.yaml`.

Take a look:

```bash
cat clef.yaml
tree secrets
```

Commit the initial state. Clef is git-native and the matrix files are SOPS-encrypted, so they're safe to commit even once you start adding values:

```bash
git add clef.yaml .clef .clefignore .gitattributes secrets
git commit -m "Initialise Clef"
```

## Step 2 — Populate the matrix

Set your first secret with an inline value:

```bash
npx clef set database/dev DB_HOST localhost
```

Now set one with hidden input — Clef prompts and never echoes the value to the terminal or writes it to disk:

```bash
npx clef set database/dev DB_PASSWORD
# Value: ********
```

Confirm it landed:

```bash
npx clef get database/dev DB_PASSWORD
```

To populate the rest of the matrix in one go, paste this block:

```bash
npx clef set database/dev        DB_USER       dev_user
npx clef set database/production DB_HOST       db.prod.internal
npx clef set database/production DB_USER       app
npx clef set database/production DB_PASSWORD   --random
npx clef set payments/dev        STRIPE_KEY    sk_test_demo
npx clef set payments/dev        WEBHOOK_URL   https://dev.example.com/webhooks/stripe
npx clef set payments/production STRIPE_KEY    --random
npx clef set payments/production WEBHOOK_URL   https://example.com/webhooks/stripe
```

`--random` generates a cryptographically random placeholder and marks the key as **pending** — Clef tracks placeholders so you can find them later with `clef lint`.

## Step 3 — Explore the matrix

Compare environments side by side:

```bash
npx clef diff database dev production
```

Validate the whole repo — schema compliance, matrix completeness, SOPS integrity:

```bash
npx clef lint
```

Open the local web UI to browse the matrix visually:

```bash
npx clef ui
```

This binds to `127.0.0.1:7777` only. From the UI you can edit secrets with masked values, diff environments, and run lint with one click. Press `Ctrl-C` to stop the server when you're done.

## Step 4 — Provision KMS and migrate `production`

Steps 4 and 5 use AWS. Make sure your credentials are set:

```bash
aws sts get-caller-identity
```

The `@clef-sh/cdk` `ClefSecret` and `ClefParameter` constructs require **KMS-envelope identities** — they need a customer KMS key to wrap each pack's data encryption key. The `infra/` directory ships two CDK stacks for this:

- **`QuickStartKms`** — provisions the KMS key plus the alias `alias/clef-quick-start`.
- **`QuickStartApp`** — deploys three `ClefSecret`s into AWS Secrets Manager. We deploy this in step 5.

The KMS stack uses a fixed alias, so we can compute its ARN up front:

```bash
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
REGION=${AWS_REGION:-$(aws configure get region)}
KMS_ARN="arn:aws:kms:${REGION}:${ACCOUNT}:alias/clef-quick-start"
```

PowerShell equivalent:

```powershell
$ACCOUNT = aws sts get-caller-identity --query Account --output text
$REGION  = if ($env:AWS_REGION) { $env:AWS_REGION } else { aws configure get region }
$KMS_ARN = "arn:aws:kms:${REGION}:${ACCOUNT}:alias/clef-quick-start"
```

Create the `app` service identity:

```bash
npx clef service create app \
  --runtime \
  --namespaces database,payments \
  --kms-env production=aws:$KMS_ARN
```

Scoped to both namespaces, with KMS-envelope encryption on `production`. `dev` stays on age — fine, since the CDK stack only deploys production secrets. `--runtime` keeps `clef` from re-encrypting your matrix files with a new shared age key; the CDK pack-helper handles encryption itself at synth time.

Bootstrap CDK (if needed) and deploy the KMS stack:

```bash
cd infra
npx cdk bootstrap
npx cdk deploy QuickStartKms --outputs-file ./kms-outputs.json
cd ..
```

Now re-encrypt the `production` matrix cells with KMS (dev stays on age):

```bash
npx clef migrate-backend \
  --aws-kms-arn $KMS_ARN \
  --environment production
```

`clef migrate-backend` decrypts each `*/production.enc.yaml` cell with your age key and re-encrypts it under the new KMS key, in place. Verify with `clef lint` — the production cells should now show the new backend.

## Step 5 — Deploy secrets to AWS Secrets Manager

Take a look at `infra/lib/app-stack.ts` to see the `ClefSecret` calls. Each construct synthesises one Secrets Manager secret, with the value computed at deploy time from the encrypted Clef matrix.

The `shape` property is a template with `{{name}}` placeholders, and `refs` binds each placeholder to a `(namespace, key)` pair in the matrix. Namespace and key stay as separate fields rather than collapsing into a single token, which keeps `DB_USER` from `database` distinct from any future `DB_USER` in another namespace this identity spans. `shape` also accepts an object literal — see `PaymentsConfig` in `app-stack.ts` for a JSON-shaped secret. The unwrap happens inside a synth-time pack step plus a CloudFormation Custom Resource at deploy — see [How `ClefSecret` stays secure](https://github.com/clef-sh/clef/tree/main/packages/cdk#how-clefsecret-stays-secure) for the per-deploy KMS grant model.

Deploy:

```bash
cd infra
npx cdk deploy QuickStartApp -c app=true
cd ..
```

The `-c app=true` flag opts the app stack into synth — see the comment in `infra/bin/infra.ts` for why we gate it.

Once the stack settles, list the new secrets:

```bash
aws secretsmanager list-secrets \
  --filters Key=tag-value,Values=clef-quick-start \
  --query 'SecretList[].Name'
```

Read one back the way your application would:

```bash
aws secretsmanager get-secret-value \
  --secret-id clef-quick-start/database-url \
  --query SecretString --output text
```

That value was never typed in plaintext at deploy time — it was reconstructed from `secrets/database/production.enc.yaml` inside the synth pack step, wrapped under your KMS key, and unwrapped exactly once by the per-deploy grant.

## Step 6 — Connect Clef Cloud (optional)

So far everything is local: rotation due-dates, schema rules, lint warnings — they live in `.clef/policy.yaml` and only fire when *you* run `clef lint` or `clef policy check`. To enforce them across a team, you push the repo and let the Clef Cloud bot watch it on every PR.

`clef init` already scaffolded two files for this:

- **`.clef/policy.yaml`** — declares rotation cadence per namespace, schema requirements, allowed backends, and any custom policy rules.
- **`.github/workflows/clef-compliance.yml`** — a GitHub Actions workflow that runs `clef policy check` on each PR, writes `compliance.json`, and uploads it as the workflow artifact the bot reads.

Install the GitHub App and link this repo to a Clef Cloud workspace:

```bash
npx clef cloud init
```

This authenticates you via GitHub OAuth (device flow), installs the **Clef** GitHub App on the repository, and registers the workspace. The CLI is non-destructive — `.clef/policy.yaml` is left alone if it already exists.

Once installed, the bot will:

- post a status check on every PR summarising rotation overdue counts, schema violations, and pending placeholders,
- block merges that violate `.clef/policy.yaml` (configurable per rule), and
- populate the Cloud dashboard with the compliance history of the repo.

**The dashboard won't show data until you actually push and let CI run.** Compliance is computed from the `compliance.json` artifact produced by `.github/workflows/clef-compliance.yml`, so:

```bash
git add .clef/policy.yaml .github/workflows/clef-compliance.yml
git commit -m "Enable Clef Cloud"
git push
```

Open a PR (even a no-op one) to trigger the workflow, then check the dashboard. The bot's status check will appear on the PR and the dashboard tile for this repo will fill in once the workflow finishes.

This is how governance and policy enforcement come into play: `policy.yaml` is the spec, the workflow is the enforcement point, and the bot is the cross-team visibility layer. Local devs get the same checks via `clef lint` / `clef policy check`, so violations surface long before review.

## What you just built

Step back for a second — in the last ~10 minutes you stood up:

- **A central, version-controlled source of truth for secrets.** Every value lives in `secrets/<ns>/<env>.enc.yaml`, encrypted with SOPS, diffable in git, reviewable in PRs.
- **Per-environment encryption with a clean handoff to AWS.** `dev` rides on age for friction-free local work; `production` is sealed with your own KMS key. The CDK constructs deliver those values into AWS Secrets Manager so applications keep using the standard `aws-sdk` — no Clef binary, no agent, no sidecar.
- **Rotation and schema tracking with a path to enforcement.** `clef lint` already flags pending placeholders and policy violations locally; once Clef Cloud is connected, the same checks run on every PR and the dashboard tracks rotation health across repositories.

If you swap the demo `--random` placeholders for real values, point a real service at the secrets via the AWS SDK, and add a schema for each namespace, the same pattern scales straight from this tutorial to a production setup.

## Cleaning up

This repo is meant to be thrown away. To remove the AWS resources you just deployed:

```bash
cd infra
npx cdk destroy QuickStartApp QuickStartKms
```

Then `rm -rf` the directory or re-clone if you want to run through the tutorial again.

## Where to go next

- **`@clef-sh/cdk` reference** — [github.com/clef-sh/clef/tree/main/packages/cdk](https://github.com/clef-sh/clef/tree/main/packages/cdk) covers the other constructs (`ClefArtifactBucket` for S3 delivery, `ClefParameter` for SSM Parameter Store) and synth-time validation.
- **Schemas** — define required keys and value patterns per namespace; `clef lint` will then enforce them. See [docs.clef.sh/guide/schemas](https://docs.clef.sh/guide/schemas).
- **CI** — for GitHub Actions, OIDC into KMS so CI never holds long-lived credentials. See [docs.clef.sh/guide/ci](https://docs.clef.sh/guide/ci).

If you hit anything that didn't work, please [open an issue](https://github.com/clef-sh/quick-start/issues) — the goal is for this tutorial to run cleanly for everyone.
