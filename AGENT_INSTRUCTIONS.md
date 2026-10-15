# Instructions for the AI agent: deploy "Blood Donor Finder" to AWS

You are deploying a finished AWS course project from this folder into the user's AWS account, using the
user's Chrome browser where they are already signed in to the AWS Console. **Do not write or change any code.**
Everything is already built and tested. Your job is only to deploy, verify and report back.

## Ground rules (follow strictly)

1. **Region must be Asia Pacific (Mumbai) `ap-south-1`** for every step. Check the region selector (top right of
   the console) before each service you open.
2. **Never** upgrade the account plan, buy a support plan, enter payment details, create IAM access keys, or
   change account/billing settings. If the console asks for any of these, stop and ask the user.
3. **Ask the user for their email address** before starting (it receives alarm/budget emails). Do not guess it.
4. Do not edit `infra/template.yaml` unless a step below explicitly says to.
5. If any step fails, **stop**, copy the exact error text (for CloudFormation: the first red `CREATE_FAILED` row in
   the **Events** tab, the "Status reason" column) and show it to the user. Do not retry with random changes.
6. The project uses the user's AWS credits (~$1.20 per day while deployed). Remind the user to tear down after the demo.

---

## Path A (recommended): AWS CloudShell, 4 commands

1. Open https://ap-south-1.console.aws.amazon.com/console/home?region=ap-south-1 and confirm region = Mumbai.
2. Click the **CloudShell** icon (`>_`) in the top navigation bar. Wait until the terminal prompt appears.
3. In CloudShell: **Actions → Upload file** → choose the project zip file the user gave you
   (named like `blood-donor-finder.zip`).
4. Run these commands one by one (replace the email with the user's email):
   ```bash
   unzip -o blood-donor-finder.zip
   cd blood-donor-finder
   chmod +x *.sh
   ./deploy.sh USER_EMAIL_HERE
   ```
   If the zip was extracted into a differently named folder, `cd` into the folder that contains `deploy.sh`.
5. Wait. It takes **about 10–15 minutes** (CloudFront is slow). Do not close the tab. It finishes by printing
   a table of outputs. Copy the **WebsiteURL** value.
6. Go to **Verification** below.

If CloudShell is unavailable or the upload fails, use Path B.

---

## Path B (fallback): only console clicks, no terminal

### B1. Upload the app package to S3
1. Open **S3** → **Create bucket**.
2. Bucket name: `blood-donor-artifacts-` followed by 8 random lowercase letters/digits (must be globally unique).
   Region: **ap-south-1**. Keep "Block all public access" **ON**. Click **Create bucket**.
3. Open the bucket → **Upload** → add the file **`prebuilt/app.zip`** from this folder → **Upload**.
   Its key must be exactly `app.zip`.

### B2. Create the CloudFormation stack
1. Open **CloudFormation** → **Create stack → With new resources (standard)**.
2. **Upload a template file** → choose **`infra/template.yaml`** → Next.
3. Stack name: `blood-donor`
4. Parameters:
   - `ArtifactBucket` = the bucket name from B1
   - `ArtifactKey` = `app.zip`
   - `AlertEmail` = the user's email
   - Leave everything else at its default (`InstanceType` t3.micro, `BudgetAmountUSD` 5, `LatestAmiId` default).
5. Next → leave stack options as default → Next.
6. At the bottom, tick **"I acknowledge that AWS CloudFormation might create IAM resources with custom names."**
7. **Submit**. Watch the **Events** tab. Wait for status **CREATE_COMPLETE** (about 10–15 minutes).
8. Open the **Outputs** tab and copy **WebsiteURL**.

---

## Verification (do all of these and report results)

1. Wait 3 minutes after the stack completes (EC2 is installing the app), then open **WebsiteURL**.
   - Expected: dark page titled **HaemaLink** with counters "Registered Donors 10" and "Active Emergencies 2".
   - If you see 502/503, wait 2 more minutes and refresh (up to 3 times).
2. On the "Find Compatible Donors" tab, blood group **A+** is selected by default. Expected: a list of 6 donors appears.
3. Open **CloudFormation → blood-donor → Resources** and confirm every row is `CREATE_COMPLETE`.
4. Open **EC2 → Target Groups** → the stack's target group → **Targets**: one target should be **healthy**.
5. Tell the user:
   - the WebsiteURL,
   - to open their email and click **Confirm subscription** on the "AWS Notification" email (admin alerts),
   - the demo tip below.

6. Optional WAF check (Path A only): in CloudShell run `./demo-waf.sh`. Expected: after ~10 attempts it prints
   `429 BLOCKED BY AWS WAF`. It sends invalid data on purpose, so no emails go out.

## Demo setup (offer to do this with the user)

1. On the website, **Become a Donor** tab → register the user with blood group **O-** and their email.
2. The user must click **Confirm subscription** in the new AWS email on their phone.
3. Test: **Post Blood Request** tab → fill any group (e.g. B+), units 1, any hospital/city/contact name,
   a 10-digit number starting with 6–9 → **Send alert to donors**.
   Expected: within ~30 seconds the user receives "URGENT: B+ blood needed at …" by email.
   (O- donors can donate to every group, so every request reaches them.)
   The bell icon (top right) also lists the request with the donor groups it alerted.
   The 2 sample requests that exist from the start never send emails.

## Services this deployment creates (for your report back to the user)

IAM, VPC (subnets, route table, internet gateway, security groups, endpoints), EC2 (launch template),
Application Load Balancer, Auto Scaling, DynamoDB (2 tables), DynamoDB Streams, Lambda, SNS (2 topics),
CloudFront, AWS WAF (web ACL on the ALB), CloudWatch (dashboard + 3 alarms), AWS Budgets. Also uses S3 and Systems Manager.

## Teardown (after the demo, when the user says so)

- **If Path A was used:** in CloudShell run `cd blood-donor-finder && ./teardown.sh`
- **If Path B was used:**
  1. CloudFormation → select `blood-donor` → **Delete** → wait until it disappears (CloudFront takes 10–15 min).
  2. S3 → the `blood-donor-artifacts-…` bucket → **Empty** → then **Delete**.

## Common errors

| Error | Fix |
|---|---|
| Budget resource fails (`MonthlyBudget` CREATE_FAILED) | Delete the stack. In `infra/template.yaml` remove the whole `MonthlyBudget:` block (under the "9. Budgets" comment), redeploy, then create a $5 monthly cost budget manually in **Billing → Budgets**. |
| `WebACL` or `WebACLAssociation` CREATE_FAILED | Show the error to the user. If they agree: delete the stack, remove the `WebACL:` and `WebACLAssociation:` blocks (under "7b. AWS WAF") and the WAF widget at the end of the dashboard body, then redeploy. |
| `t3.micro` not allowed / instance launch fails with "not eligible for Free Tier" | Redeploy with parameter `InstanceType` = `t2.micro`. |
| Stack name already exists | Delete the old `blood-donor` stack first, or use stack name `blood-donor-2`. |
| Website 502 for more than 10 minutes | EC2 → Instances → select the `blood-app` instance → **Connect → Session Manager** → run `sudo tail -50 /var/log/cloud-init-output.log` and show the output to the user. |
