# S3 Setup — buckets, layout, CORS

Two buckets (they may be the same bucket if you prefer; keep them separate in
production for clean access control):

| Bucket | Env var | Access | Holds |
|--------|---------|--------|-------|
| **Recordings** (source) | `S3_RECORDING_BUCKET` | app: **read-only** | raw call recordings (uploaded by the dialer) |
| **Output** | `S3_OUTPUT_BUCKET` | app: **read-write** | `transcriptions/` and `audits/` |

Object layout:
```
Recordings bucket
  Scaler/01_04_2024/agent-495367-1711950009-255903-Scaler-2024_04_01_11_10_09-916353969873.mp3

Output bucket
  transcriptions/495367-1711950009-255903.txt
  audits/495367-1711950009-255903.json
```
Prefixes are configurable: `S3_RECORDING_PREFIX`, `S3_TRANSCRIPTION_PREFIX`
(default `transcriptions/`), `S3_AUDIT_PREFIX` (default `audits/`).

---

## 1. Create the output bucket

(The recordings bucket already exists — `cz-scaler-support-calls`.)

```bash
aws s3api create-bucket --bucket YOUR_OUTPUT_BUCKET --region us-east-1
# Keep Block Public Access ON for both buckets — we never make objects public.
aws s3api put-public-access-block --bucket YOUR_OUTPUT_BUCKET \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
# Recommended: server-side encryption + versioning
aws s3api put-bucket-encryption --bucket YOUR_OUTPUT_BUCKET \
  --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
```

Then set both buckets in `.env.local`:
```env
S3_RECORDING_BUCKET=cz-scaler-support-calls
S3_OUTPUT_BUCKET=YOUR_OUTPUT_BUCKET
```

---

## 2. CORS

> **When is CORS needed?** Only when a **browser** fetches an S3 object
> **directly** (cross-origin) — e.g. playing the recording audio or downloading
> a transcript via a presigned URL in the dashboard. The backend itself does not
> need CORS (server-side calls aren't subject to it), and today the API proxies
> transcript text through `GET /api/audits/:id/transcript`. Apply CORS now if you
> intend to add in-browser playback/download (recommended), so it's ready.

### Recordings bucket — read-only (`GET`, `HEAD`)
```json
[
  {
    "AllowedHeaders": ["*"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedOrigins": ["https://your-dashboard-domain.com"],
    "ExposeHeaders": ["ETag", "Content-Length", "Content-Range", "Accept-Ranges"],
    "MaxAgeSeconds": 3000
  }
]
```
(`Content-Range`/`Accept-Ranges` are exposed so the browser `<audio>` element can
seek with range requests.)

### Output bucket — read-only from the browser (transcripts / audit JSON)
```json
[
  {
    "AllowedHeaders": ["*"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedOrigins": ["https://your-dashboard-domain.com"],
    "ExposeHeaders": ["ETag", "Content-Length"],
    "MaxAgeSeconds": 3000
  }
]
```
The app writes outputs server-side, so the browser only ever needs `GET`/`HEAD`
here — no `PUT`/`POST` in CORS.

Apply with the CLI:
```bash
aws s3api put-bucket-cors --bucket cz-scaler-support-calls       --cors-configuration file://recordings-cors.json
aws s3api put-bucket-cors --bucket YOUR_OUTPUT_BUCKET            --cors-configuration file://output-cors.json
```
Use `http://localhost:3000` as the origin for local dev (match `CORS_ORIGIN`).

> Because Block Public Access stays ON, the browser must use a **presigned URL**
> to read objects. The presigned-URL endpoint isn't built yet — see "Next step".

---

## 3. IAM

The app's role needs read on the recordings bucket and read-write on the output
bucket. The full least-privilege policy (S3 + SQS + DynamoDB) is in
[PRODUCTION.md](PRODUCTION.md#least-privilege-iam-policy-workers--api).

---

## 4. Connect the recordings bucket to the pipeline

Uploads must notify the transcription queue — that wiring (queue access policy +
`s3:ObjectCreated:*` notification, with optional `.mp3` suffix / prefix filter)
is documented in [SQS_SETUP.md](SQS_SETUP.md#2-connect-s3--the-transcription-queue).

---

## 5. Lifecycle / retention (recommended)

Audit rows + result JSON are small and worth keeping; transcripts and recordings
are the bulk. Example: expire transcripts after N days, transition recordings to
Glacier. Confirm retention against your PII/compliance policy (recordings +
customer numbers are personal data).
```bash
aws s3api put-bucket-lifecycle-configuration --bucket YOUR_OUTPUT_BUCKET \
  --lifecycle-configuration '{"Rules":[{"ID":"expire-transcripts","Filter":{"Prefix":"transcriptions/"},"Status":"Enabled","Expiration":{"Days":365}}]}'
```

---

## Next step (not yet built): presigned URLs

To play recordings / download transcripts in the browser, add an endpoint that
returns a short-lived presigned `GetObject` URL (`@aws-sdk/s3-request-presigner`),
scope-checked like the other audit routes. Tell me if you want this and I'll add
it — it pairs with the CORS above.
