import * as cdk from 'aws-cdk-lib';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';

export class QuickStartKmsStack extends cdk.Stack {
  readonly envelopeKey: kms.Key;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.envelopeKey = new kms.Key(this, 'ClefEnvelopeKey', {
      alias: 'alias/clef-quick-start',
      description:
        'Clef quick-start: wraps the data encryption keys used by `clef pack` for the `app` service identity in production.',
      enableKeyRotation: true,
      pendingWindow: cdk.Duration.days(7),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    new cdk.CfnOutput(this, 'KmsKeyArn', {
      value: this.envelopeKey.keyArn,
      description:
        'Pass this ARN to `clef migrate-backend --aws-kms-arn` and `clef service create --kms-env production=awskms:<arn>`.',
      exportName: 'QuickStartKmsKeyArn',
    });
  }
}
