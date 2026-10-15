#!/usr/bin/env bash
# Deploys everything to AWS. Run it in AWS CloudShell (nothing to install).
# Usage: ./deploy.sh your@email.com
set -euo pipefail

EMAIL="${1:?Usage: ./deploy.sh <your-email>}"
STACK="${STACK:-blood-donor}"
REGION="${AWS_REGION:-ap-south-1}"
cd "$(dirname "$0")"

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
BUCKET="${STACK}-artifacts-${ACCOUNT}-${REGION}"
KEY="app-$(date +%Y%m%d%H%M%S).zip"

echo "==> Artifact bucket: $BUCKET"
if ! aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  if [ "$REGION" = "us-east-1" ]; then
    aws s3api create-bucket --bucket "$BUCKET" --region "$REGION"
  else
    aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
      --create-bucket-configuration LocationConstraint="$REGION"
  fi
  aws s3api put-public-access-block --bucket "$BUCKET" \
    --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
fi

echo "==> Packaging app"
rm -rf build && mkdir build
(cd app && npm install --omit=dev --no-audit --no-fund --silent && zip -qr "../build/$KEY" server.js package.json public node_modules)
aws s3 cp "build/$KEY" "s3://$BUCKET/$KEY" --region "$REGION"

echo "==> Deploying CloudFormation stack '$STACK' (first run takes ~10 min, CloudFront is the slow part)"
aws cloudformation deploy \
  --region "$REGION" \
  --stack-name "$STACK" \
  --template-file infra/template.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides ArtifactBucket="$BUCKET" ArtifactKey="$KEY" AlertEmail="$EMAIL"

echo
aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" \
  --query 'Stacks[0].Outputs[].[OutputKey,OutputValue]' --output table
echo
echo "Done. Confirm the AWS emails sent to $EMAIL (admin alarms)."
echo "The app needs ~2-3 more minutes after this to boot on EC2."
