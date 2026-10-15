#!/usr/bin/env bash
# Viva demo: push CPU to 100% on the app servers using Systems Manager Run Command
# (no SSH), then watch Auto Scaling add instances on the CloudWatch dashboard.
set -euo pipefail
STACK="${STACK:-blood-donor}"
REGION="${AWS_REGION:-ap-south-1}"
MINUTES="${1:-8}"

ASG=$(aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='AutoScalingGroupName'].OutputValue" --output text)

echo "==> Simulating an emergency traffic spike on $ASG for $MINUTES minutes"
aws ssm send-command --region "$REGION" \
  --document-name AWS-RunShellScript \
  --targets "Key=tag:aws:autoscaling:groupName,Values=$ASG" \
  --parameters "commands=[\"for i in \$(seq \$(nproc)); do timeout $((MINUTES*60)) sh -c 'while :; do :; done' & done\"]" \
  --query 'Command.CommandId' --output text

echo "==> Watching instance count (Ctrl+C to stop watching; load stops by itself)"
for _ in $(seq 1 $((MINUTES*2))); do
  COUNT=$(aws autoscaling describe-auto-scaling-groups --region "$REGION" --auto-scaling-group-names "$ASG" \
    --query 'AutoScalingGroups[0].Instances | length(@)' --output text)
  echo "$(date +%H:%M:%S)  instances: $COUNT"
  sleep 30
done
