#!/usr/bin/env bash
# Deletes everything so you stop paying. Run after every demo.
set -euo pipefail
STACK="${STACK:-blood-donor}"
REGION="${AWS_REGION:-ap-south-1}"
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
BUCKET="${STACK}-artifacts-${ACCOUNT}-${REGION}"

echo "==> Deleting stack $STACK (CloudFront can take 10-15 min)"
aws cloudformation delete-stack --region "$REGION" --stack-name "$STACK"
aws cloudformation wait stack-delete-complete --region "$REGION" --stack-name "$STACK"

echo "==> Deleting artifact bucket $BUCKET"
aws s3 rb "s3://$BUCKET" --force --region "$REGION" || true
echo "All resources removed."
