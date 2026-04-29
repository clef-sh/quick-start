# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A ~10-minute tutorial that takes a user from an empty directory to a working [Clef](https://clef.sh) setup with secrets deployed to AWS Secrets Manager via the [`@clef-sh/cdk`](https://www.npmjs.com/package/@clef-sh/cdk) constructs. It is intentionally throwaway — users clone, run through, then `cdk destroy` and delete.

The tutorial has two halves:
- **Steps 1–3** — fully offline. Initialise Clef, populate a 2×2 namespace/environment matrix (`database`/`payments` × `dev`/`production`), explore via CLI and local UI.
- **Steps 4–5** — require AWS credentials. Deploy a KMS stack, migrate the `production` matrix cells from age to KMS-envelope encryption, create an `app` service identity, then deploy three `ClefSecret`s into AWS Secrets Manager.

All AWS resources are tagged `clef-quick-start` for easy cleanup.

## What Clef is (parent project context)

Clef is a **git-native secrets manager built on top of Mozilla SOPS**. It adds a namespace × environment matrix, schema validation, drift/lint detection, and a local web UI on top of SOPS's encryption engine. Cryptography is delegated entirely to SOPS (no custom crypto); plaintext exists only in memory; access control and audit are the cloud KMS's IAM + CloudTrail rather than a separate permission system. Encrypted secrets live in git alongside code.

The parent monorepo is at [`clef-sh/clef`](https://github.com/clef-sh/clef). Packages this tutorial uses:

- **`@clef-sh/cli`** (`packages/cli/`) — the `clef` command (init, set, get, diff, lint, ui, migrate-backend, service, …).
- **`@clef-sh/cdk`** (`packages/cdk/`) — AWS CDK L2 constructs: `ClefSecret`, `ClefParameter`, `ClefArtifactBucket`. The tutorial uses `ClefSecret`.

Other packages exist in the parent repo (`@clef-sh/core`, `@clef-sh/runtime`, `@clef-sh/agent`, `@clef-sh/ui`, etc.) but the quick-start does not depend on them directly. The runtime/agent path is the *alternative* to the CDK delivery path the tutorial demonstrates — relevant only if a user asks "how would this work without CDK?"

Authoritative docs live in `docs/` of the parent repo (VitePress site, also published at [docs.clef.sh](https://docs.clef.sh)). The most relevant pages for quick-start questions:

- `docs/guide/concepts.md` — matrix, namespaces, environments, recipients
- `docs/guide/service-identities.md` — what a service identity is and why CDK needs one
- `docs/cdk/overview.md`, `docs/cdk/secret.md` — `ClefSecret` semantics and the synth-time pack model
- `docs/backends/aws-kms.md` — KMS-envelope details

## Common commands

Setup (already done if you're operating in this tree):
```bash
npm install                 # installs the clef CLI under node_modules/.bin
npx clef doctor             # verifies node, sops, git
```

Tutorial CLI flow (Clef is git-native; matrix files are SOPS-encrypted and committable):
```bash
npx clef init --namespaces database,payments --environments dev,production --backend age --non-interactive
npx clef set <ns>/<env> <KEY> [value|--random]   # omit value for hidden prompt
npx clef get <ns>/<env> <KEY>
npx clef diff <ns> <envA> <envB>
npx clef lint                                     # schema, completeness, SOPS integrity
npx clef ui                                       # local web UI on 127.0.0.1:7777
```

KMS migration + service identity (after the KMS stack deploy):
```bash
npx clef migrate-backend --aws-kms-arn <KmsKeyArn> --environment production
npx clef service create app --namespaces database,payments --kms-env production=aws:<KmsKeyArn>
```

CDK (run from `infra/`):
```bash
cd infra
npx cdk bootstrap                                              # once per account/region
npx cdk deploy QuickStartKms --outputs-file ./kms-outputs.json
npx cdk deploy QuickStartApp
npx cdk destroy QuickStartApp QuickStartKms                    # cleanup
```

Verify deployed secrets:
```bash
aws secretsmanager list-secrets --filters Key=tag-value,Values=clef-quick-start --query 'SecretList[].Name'
aws secretsmanager get-secret-value --secret-id clef-quick-start/database-url --query SecretString --output text
```

## Architecture

**The matrix.** `secrets/<namespace>/<environment>.enc.yaml` is the storage unit — one SOPS-encrypted file per (namespace, environment) cell. `clef.yaml` declares namespaces, environments, and recipients. `.clef/config.yaml` records local key locations. `.clefignore` and `.gitattributes` wire up the SOPS merge driver so encrypted YAML diffs cleanly in git.

**Backends are per-cell, not per-repo.** The tutorial starts everything on age, then `clef migrate-backend --environment production` re-encrypts only the production cells under a KMS key. `dev` stays on age. This is intentional: the CDK stack only deploys production secrets, and KMS-envelope is only required where a CDK construct will read it.

**age vs KMS-envelope.** age uses persistent keypairs stored in the OS keychain (or `~/.config/clef/keys/`). KMS-envelope generates an *ephemeral* age key per pack, encrypts the matrix data with it, then wraps that ephemeral private key under AWS KMS — the wrapped key travels in the artifact, and KMS unwraps it exactly once at deploy. `ClefSecret`/`ClefParameter` constructs require KMS-envelope identities; `ClefArtifactBucket` works with either.

**Service identity is the bridge to deploy.** A service identity (`app` here) scopes which namespaces a consumer can read and configures envelope encryption per environment. `clef service create` writes this into `clef.yaml`. The CDK constructs reference the service identity by name and use its KMS configuration to pack secrets at synth time.

**Two CDK stacks in `infra/`:**
- `QuickStartKms` — provisions the KMS key, alias, and policy. Deploy first; its `KmsKeyArn` output feeds the `clef migrate-backend` and `clef service create` commands.
- `QuickStartApp` (`infra/lib/app-stack.ts`) — declares `ClefSecret` constructs. Each synthesises to one Secrets Manager secret whose value is computed at deploy time from the matrix.

**`ClefSecret.shape` template syntax.** References look like `${<namespace>__<KEY>}` (double underscore separator). The namespace prefix is mandatory because a single service identity can span multiple namespaces, and the prefix disambiguates same-named keys. Example: `postgres://${database__DB_USER}:${database__DB_PASSWORD}@${database__DB_HOST}:5432/app`.

**How values reach AWS without an agent (the synth-pack-deploy path).**
1. *Synth time:* `@clef-sh/cdk` spawns a Node helper that decrypts the scoped SOPS files (using local age key for dev, AWS SDK creds for KMS-envelope) and produces an age-encrypted envelope tied to the service identity's ephemeral key, with the wrap key under your customer KMS key.
2. *Deploy time:* a CloudFormation Custom Resource is granted a single-use KMS grant, unwraps the envelope, writes plaintext to Secrets Manager, and the grant is consumed.
3. *Runtime:* the app reads from Secrets Manager via the standard AWS SDK. No Clef binary, no agent, no decrypt permission held by the application role.

This is the same general pattern as `aws-cdk-lib`'s `NodejsFunction` (esbuild at synth) or `DockerImageAsset` (docker build at synth) — work happens during `cdk synth`, the result lands in CloudFormation. See [How `ClefSecret` stays secure](https://github.com/clef-sh/clef/tree/main/packages/cdk#how-clefsecret-stays-secure).

**`--random` and pending keys.** `clef set ... --random` generates a cryptographically random placeholder and marks the key **pending** in a sidecar `.clef-meta.yaml` (plaintext, committed, key names only — no values). `clef lint` surfaces pending keys so you know what still needs a real value before going live.

**`clef lint`.** Validates three things: matrix completeness (no missing cell files), schema compliance (required keys present, types match — only when a namespace declares `schema:` in `clef.yaml`; the quick-start does not), and SOPS integrity (decryption succeeds, metadata valid). Exit code 1 on errors. The quick-start matrix has no schemas attached, so lint here mostly catches integrity and pending-key issues.

## Things to keep in mind when editing this tutorial

- **The repo doubles as documentation.** Steps in `README.md`, commands in `infra/`, and the post-`clef init` file layout must stay in sync. If you change a CLI flag here, also check whether the README example still matches the parent CLI's actual surface.
- **`infra/kms-outputs.json` is generated** by step 4's deploy command (`--outputs-file ./kms-outputs.json`). It's untracked and reproducible; don't commit it.
- **No tests/build pipeline live in this repo** — there's no `npm test` or `npm run build`. Validation is "did the tutorial run end-to-end against a real AWS account." If you change the tutorial flow, walk it through manually.
- **UI binds `127.0.0.1:7777` only**, never `0.0.0.0`. Do not suggest changing this — it's a Clef-wide non-negotiable.
- **No plaintext to disk, ever.** All decryption flows through SOPS stdin/stdout. Don't suggest "just write it to a temp file" workarounds.
