#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { QuickStartKmsStack } from '../lib/kms-stack';
import { QuickStartAppStack } from '../lib/app-stack';

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

new QuickStartKmsStack(app, 'QuickStartKms', { env });

// `QuickStartAppStack` is gated behind the `-c app=true` context flag.
//
// Why: each `ClefSecret` in the app stack runs the Clef pack-helper at
// synth time, which decrypts the matching production matrix cell. That
// only works once
//   1. the KMS stack is deployed (so the alias resolves), and
//   2. `clef migrate-backend --environment production` has re-encrypted
//      the production cells under that key.
// CDK synthesises every stack in an app before deploying any one of them,
// so unconditionally instantiating this stack would also break
// `cdk deploy QuickStartKms`. Step 4 of the README walks through the
// prereqs; step 5 deploys the app stack with `-c app=true`.
if (app.node.tryGetContext('app')) {
  new QuickStartAppStack(app, 'QuickStartApp', { env });
}

cdk.Tags.of(app).add('Project', 'clef-quick-start');
