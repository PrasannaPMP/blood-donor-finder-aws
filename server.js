// Blood Donor Finder — backend
// Runs on EC2 behind an ALB. Donors and requests live in DynamoDB; alerts go out through SNS.
// With no DONORS_TABLE set it runs in LOCAL mode (in-memory) so you can test on a laptop.

const express = require('express');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DONORS = process.env.DONORS_TABLE;
const REQUESTS = process.env.REQUESTS_TABLE;
const TOPIC_ARN = process.env.TOPIC_ARN;
const REGION = process.env.AWS_REGION || 'ap-south-1';
const LOCAL = !DONORS;

const GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
// Which donor groups can give to a patient of each group
const CAN_RECEIVE_FROM = {
  'O-': ['O-'],
  'O+': ['O+', 'O-'],
  'A-': ['A-', 'O-'],
  'A+': ['A+', 'A-', 'O+', 'O-'],
  'B-': ['B-', 'O-'],
  'B+': ['B+', 'B-', 'O+', 'O-'],
  'AB-': ['AB-', 'A-', 'B-', 'O-'],
  'AB+': GROUPS,
};
const DAY = 86400000;

// Demo donors (fictional people, fictional numbers) — inserted only on first start
const SEED = [
  ['Arjun K', 'O+', 'Vellore', '9000000011', 200],
  ['Meera S', 'O-', 'Vellore', '9000000012', 30],
  ['Rahul V', 'A+', 'Vellore', '9000000013', 120],
  ['Divya R', 'B+', 'Katpadi', '9000000014', 400],
  ['Karthik M', 'AB+', 'Vellore', '9000000015', 95],
  ['Sneha P', 'A-', 'Chennai', '9000000016', 365],
  ['Vikram J', 'B-', 'Chennai', '9000000017', 10],
  ['Anjali T', 'O+', 'Chennai', '9000000018', 150],
  ['Farhan A', 'AB-', 'Katpadi', '9000000019', 500],
  ['Lakshmi N', 'O-', 'Chennai', '9000000020', 220],
].map(([name, bloodGroup, city, phone, daysAgo], i) => ({
  donorId: 'seed-' + (i + 1), name, bloodGroup, city, phone,
  lastDonated: new Date(Date.now() - daysAgo * DAY).toISOString().slice(0, 10),
  createdAt: Date.now() - daysAgo * DAY,
}));

// Demo requests (fictional) so the requests list is not empty on first start.
// isSeed=true tells the Lambda NOT to email anyone for these.
const SEED_REQUESTS = [
  ['req-seed-1', 'Kavitha R', 'B+', 2, 'City General Hospital', 'Vellore', 'Ramesh', '9000000031', 45],
  ['req-seed-2', 'Sanjay K', 'O-', 3, 'Sunrise Multispeciality Hospital', 'Chennai', 'Pooja', '9000000032', 120],
].map(([requestId, patientName, bloodGroup, units, hospital, city, contactName, contactPhone, minsAgo]) => ({
  requestId, patientName, bloodGroup, units, hospital, city, contactName, contactPhone, isSeed: true,
  createdAt: Date.now() - minsAgo * 60000,
  expiresAt: Math.floor((Date.now() + 7 * DAY) / 1000),
}));

// ---------------------------------------------------------------- data layer
let db;
if (LOCAL) {
  const donors = new Map(SEED.map(d => [d.donorId, d]));
  const requests = new Map(SEED_REQUESTS.map(r => [r.requestId, r]));
  db = {
    async listDonors() { return [...donors.values()]; },
    async addDonor(d) { donors.set(d.donorId, d); console.log(`[LOCAL SNS] ${d.email} subscribed for ${d.bloodGroup} alerts`); },
    async listRequests() { return [...requests.values()]; },
    async addRequest(r) {
      requests.set(r.requestId, r);
      // Mimic DynamoDB Stream -> Lambda -> SNS so alerts are visible locally
      console.log(`[LOCAL SNS] ${r.bloodGroup} needed at ${r.hospital} -> alert donors: ${(CAN_RECEIVE_FROM[r.bloodGroup] || []).join(', ')}`);
    },
    async seed() {},
  };
} else {
  const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
  const { DynamoDBDocumentClient, ScanCommand, PutCommand } = require('@aws-sdk/lib-dynamodb');
  const { SNSClient, SubscribeCommand } = require('@aws-sdk/client-sns');
  // No access keys anywhere: credentials come from the EC2 instance's IAM role
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
  const sns = new SNSClient({ region: REGION });

  const scanAll = async table => {
    const items = []; let ExclusiveStartKey;
    do {
      const out = await ddb.send(new ScanCommand({ TableName: table, ExclusiveStartKey }));
      items.push(...(out.Items || [])); ExclusiveStartKey = out.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return items;
  };

  db = {
    listDonors: () => scanAll(DONORS),
    async addDonor(d) {
      const { email, ...item } = d;   // email lives only in SNS, not in the public table
      await ddb.send(new PutCommand({ TableName: DONORS, Item: item }));
      // Filter policy: this donor only gets requests their group can serve
      await sns.send(new SubscribeCommand({
        TopicArn: TOPIC_ARN, Protocol: 'email', Endpoint: email,
        Attributes: { FilterPolicy: JSON.stringify({ bloodGroup: [d.bloodGroup] }) },
      }));
    },
    listRequests: () => scanAll(REQUESTS),
    // This insert lands in the DynamoDB Stream; the Lambda sends the alerts
    async addRequest(r) { await ddb.send(new PutCommand({ TableName: REQUESTS, Item: r })); },
    async seed() {
      for (const d of SEED) {
        try {
          await ddb.send(new PutCommand({ TableName: DONORS, Item: d, ConditionExpression: 'attribute_not_exists(donorId)' }));
        } catch (e) { if (e.name !== 'ConditionalCheckFailedException') throw e; }
      }
      for (const r of SEED_REQUESTS) {
        try {
          await ddb.send(new PutCommand({ TableName: REQUESTS, Item: r, ConditionExpression: 'attribute_not_exists(requestId)' }));
        } catch (e) { if (e.name !== 'ConditionalCheckFailedException') throw e; }
      }
    },
  };
}

// ---------------------------------------------------------------- helpers
const clean = (v, max = 60) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
const maskPhone = p => p.slice(0, 2) + 'xxxxxx' + p.slice(-2);
const eligible = last => !last || (Date.now() - new Date(last).getTime()) >= 90 * DAY;  // 90-day gap between donations
const publicDonor = d => ({
  name: d.name, bloodGroup: d.bloodGroup, city: d.city, phone: maskPhone(d.phone),
  lastDonated: d.lastDonated || null, eligible: eligible(d.lastDonated),
});

// ---------------------------------------------------------------- HTTP API
const app = express();
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '5m' }));
const wrap = fn => (req, res) => fn(req, res).catch(err => {
  console.error(err); res.status(500).json({ error: 'Something went wrong on the server' });
});

app.get('/health', (req, res) => res.json({ ok: true, mode: LOCAL ? 'local' : 'aws' }));

// Stats for the top of the page
app.get('/api/stats', wrap(async (req, res) => {
  const [donors, requests] = await Promise.all([db.listDonors(), db.listRequests()]);
  const now = Date.now();
  res.json({
    donors: donors.length,
    available: donors.filter(d => eligible(d.lastDonated)).length,
    openRequests: requests.filter(r => r.expiresAt * 1000 > now).length,
  });
}));

// Search donors who can give to a patient of ?group, optionally in ?city
app.get('/api/donors', wrap(async (req, res) => {
  const group = req.query.group;
  if (!GROUPS.includes(group)) return res.status(400).json({ error: 'Choose a blood group' });
  const city = clean(req.query.city).toLowerCase();
  const ok = CAN_RECEIVE_FROM[group];
  const list = (await db.listDonors())
    .filter(d => ok.includes(d.bloodGroup) && (!city || d.city.toLowerCase().includes(city)))
    .map(publicDonor)
    .sort((a, b) => (b.eligible - a.eligible) || ((a.bloodGroup === group ? 0 : 1) - (b.bloodGroup === group ? 0 : 1)) || a.name.localeCompare(b.name));
  res.json({ group, compatible: ok, donors: list });
}));

// Register a donor
app.post('/api/donors', wrap(async (req, res) => {
  const b = req.body || {};
  const name = clean(b.name, 40), city = clean(b.city, 40), phone = String(b.phone || '').replace(/\D/g, '');
  const email = clean(b.email, 80), bloodGroup = b.bloodGroup, lastDonated = b.lastDonated || null;
  if (name.length < 2) return res.status(400).json({ error: 'Enter your name' });
  if (!GROUPS.includes(bloodGroup)) return res.status(400).json({ error: 'Choose your blood group' });
  if (city.length < 2) return res.status(400).json({ error: 'Enter your city' });
  if (!/^[6-9]\d{9}$/.test(phone)) return res.status(400).json({ error: 'Enter a valid 10-digit mobile number' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email' });
  if (lastDonated && (!/^\d{4}-\d{2}-\d{2}$/.test(lastDonated) || new Date(lastDonated) > new Date()))
    return res.status(400).json({ error: 'Last donation date cannot be in the future' });

  await db.addDonor({ donorId: crypto.randomUUID(), name, bloodGroup, city, phone, email, lastDonated, createdAt: Date.now() });
  res.json({ ok: true });
}));

// Open blood requests (newest first)
app.get('/api/requests', wrap(async (req, res) => {
  const now = Date.now();
  const list = (await db.listRequests())
    .filter(r => r.expiresAt * 1000 > now)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 20);
  res.json({ requests: list });
}));

// Post an urgent request -> DynamoDB Stream -> Lambda -> SNS email to compatible donors
app.post('/api/requests', wrap(async (req, res) => {
  const b = req.body || {};
  const r = {
    requestId: crypto.randomUUID(),
    patientName: clean(b.patientName, 40),
    bloodGroup: b.bloodGroup,
    units: Number(b.units),
    hospital: clean(b.hospital, 60),
    city: clean(b.city, 40),
    contactName: clean(b.contactName, 40),
    contactPhone: String(b.contactPhone || '').replace(/\D/g, ''),
    createdAt: Date.now(),
  };
  if (r.patientName.length < 2) return res.status(400).json({ error: 'Enter the patient name' });
  if (!GROUPS.includes(r.bloodGroup)) return res.status(400).json({ error: 'Choose the blood group needed' });
  if (!Number.isInteger(r.units) || r.units < 1 || r.units > 10) return res.status(400).json({ error: 'Units must be between 1 and 10' });
  if (r.hospital.length < 2) return res.status(400).json({ error: 'Enter the hospital name' });
  if (r.city.length < 2) return res.status(400).json({ error: 'Enter the city' });
  if (r.contactName.length < 2) return res.status(400).json({ error: 'Enter a contact person' });
  if (!/^[6-9]\d{9}$/.test(r.contactPhone)) return res.status(400).json({ error: 'Enter a valid 10-digit contact number' });
  r.expiresAt = Math.floor((r.createdAt + 7 * DAY) / 1000);   // DynamoDB TTL removes it after 7 days

  await db.addRequest(r);
  res.json({ ok: true, alerted: CAN_RECEIVE_FROM[r.bloodGroup] });
}));

// Alerts feed: built from the requests table, so it shows the same data on every EC2 instance.
// Each request = one SNS publish by the Lambda (seed requests are shown but were never emailed).
app.get('/api/alerts', wrap(async (req, res) => {
  const now = Date.now();
  const alerts = (await db.listRequests())
    .filter(r => r.expiresAt * 1000 > now)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 25)
    .map(r => ({
      id: r.requestId,
      bloodGroup: r.bloodGroup, patientName: r.patientName, hospital: r.hospital, city: r.city, units: r.units,
      contactName: r.contactName, contactPhone: r.contactPhone,
      compatible: CAN_RECEIVE_FROM[r.bloodGroup] || [],
      timestamp: r.createdAt,
      subject: `URGENT: ${r.bloodGroup} blood needed at ${r.hospital}`,
      body: `Patient: ${r.patientName} · Units needed: ${r.units} · Hospital: ${r.hospital}, ${r.city} · Contact: ${r.contactName} - ${r.contactPhone}` +
            (r.isSeed ? ' · (sample request, no email sent)' : ''),
    }));
  res.json({ alerts, isLocal: LOCAL });
}));

db.seed()
  .then(() => app.listen(PORT, () => console.log(`Blood Donor Finder on :${PORT} (${LOCAL ? 'LOCAL in-memory' : 'AWS ' + REGION})`)))
  .catch(err => { console.error('Startup failed', err); process.exit(1); });
