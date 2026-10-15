#!/usr/bin/env bash
# Viva demo: show AWS WAF blocking spam.
# Sends many "post blood request" calls from CloudShell. The bodies are deliberately invalid,
# so NO real request is saved and NO donor gets an email. After about 10 attempts in 5 minutes,
# WAF starts answering 429 "Too many requests". Your own browser (different IP) keeps working.
set -euo pipefail
STACK="${STACK:-blood-donor}"
REGION="${AWS_REGION:-ap-south-1}"

URL=$(aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='WebsiteURL'].OutputValue" --output text)
echo "==> Target: $URL/api/requests"
echo "==> Sending spam requests (WAF takes ~30-90 seconds to start blocking)..."
echo

for i in $(seq 1 60); do
  CODE=$(curl -s -o /tmp/waf-body.txt -w '%{http_code}' -X POST "$URL/api/requests" \
    -H 'Content-Type: application/json' -d '{"patientName":"spam"}')
  if [ "$CODE" = "429" ]; then
    echo "$(date +%H:%M:%S)  attempt $i -> 429 BLOCKED BY AWS WAF  $(cat /tmp/waf-body.txt)"
    BLOCKED=$((${BLOCKED:-0}+1))
    if [ "$BLOCKED" -ge 3 ]; then
      echo
      echo "WAF is blocking this IP. Open the website in your browser: it still works for you."
      echo "Blocked requests show up in: WAF & Shield -> Web ACLs -> ${STACK}-waf (Mumbai region) -> Traffic overview"
      exit 0
    fi
  else
    echo "$(date +%H:%M:%S)  attempt $i -> $CODE (reached the app)"
  fi
  sleep 3
done
echo "Not blocked yet. WAF counts over a 5-minute window; run the script again."
