import * as cdk from 'aws-cdk-lib';
import { ClefSecret } from '@clef-sh/cdk';
import { Construct } from 'constructs';

/**
 * Three `ClefSecret` constructs, each populated at deploy time from the
 * encrypted Clef matrix. The `app` service identity is created in step 4 of
 * the README and must already exist in `clef.yaml` with KMS-envelope
 * encryption configured for `production`.
 *
 * Each construct uses `{{name}}` placeholders in the `shape`, with `refs`
 * binding each placeholder to a `(namespace, key)` pair in the envelope.
 * Namespace and key are always two distinct fields — there is no `__`
 * separator on the user surface.
 */
export class QuickStartAppStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // String shape — composes a postgres connection string from three
    // separate keys in `database/production`. The whole string is the secret.
    new ClefSecret(this, 'DatabaseUrl', {
      identity: 'app',
      environment: 'production',
      secretName: 'clef-quick-start/database-url',
      shape: 'postgres://{{user}}:{{pass}}@{{host}}:5432/app',
      refs: {
        user: { namespace: 'database', key: 'DB_USER' },
        pass: { namespace: 'database', key: 'DB_PASSWORD' },
        host: { namespace: 'database', key: 'DB_HOST' },
      },
    });

    // String shape, single reference — the simplest case.
    new ClefSecret(this, 'StripeKey', {
      identity: 'app',
      environment: 'production',
      secretName: 'clef-quick-start/stripe-key',
      shape: '{{stripeKey}}',
      refs: {
        stripeKey: { namespace: 'payments', key: 'STRIPE_KEY' },
      },
    });

    // JSON shape — multiple fields, mixing Clef references with literal
    // values. Consumers read this as a JSON-encoded string from ASM.
    new ClefSecret(this, 'PaymentsConfig', {
      identity: 'app',
      environment: 'production',
      secretName: 'clef-quick-start/payments-config',
      shape: {
        stripeKey: '{{stripeKey}}',
        webhookUrl: '{{webhookUrl}}',
        environment: 'production',
      },
      refs: {
        stripeKey: { namespace: 'payments', key: 'STRIPE_KEY' },
        webhookUrl: { namespace: 'payments', key: 'WEBHOOK_URL' },
      },
    });
  }
}
