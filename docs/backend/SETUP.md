# CX Audit Backend - Quick Start Guide

## What's Been Built

The backend is now fully configured with:

- ✅ **Express.js REST API** with 6 endpoints
- ✅ **AWS S3 Integration** for call audio file processing
- ✅ **OpenAI Integration** for Whisper transcription and GPT-4 audit scoring
- ✅ **Environment Validation** with automatic warnings for missing credentials
- ✅ **Structured Logging** with configurable log levels (debug, info, warn, error)
- ✅ **Input Validation** for all API requests
- ✅ **Error Handling** with proper HTTP status codes
- ✅ **Health Check Endpoint** to verify service status
- ✅ **TypeScript** with full type safety across all modules

## Prerequisites

- Node.js v20+ (Use: `nvm use 20`)
- npm v10+
- AWS S3 bucket with call audio files (naming: `agent-{ID}-{TIMESTAMP}-{PHONE}.mp3`)
- OpenAI API key with GPT-4 access

## Getting Started - 3 Steps

### Step 1: Configure Environment Variables

Edit `.env.local` in the backend folder and add your credentials:

```bash
# .env.local
PORT=4000
NODE_ENV=development
LOG_LEVEL=info

AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=xxxxx
AWS_SECRET_ACCESS_KEY=xxxxx
S3_BUCKET_NAME=your-bucket-name
S3_PREFIX=

OPENAI_API_KEY=sk-xxxxx
OPENAI_TRANSCRIPTION_MODEL=whisper-1
OPENAI_AUDIT_MODEL=gpt-4-turbo-preview
```

### Step 2: Start the Backend

```bash
cd CX-audit-backend
nvm use 20
npm run dev
```

You should see:
```
[2026-06-02T10:15:30.123Z] INFO   CX Audit backend listening at http://localhost:4000
[2026-06-02T10:15:30.124Z] INFO   Environment: development, Log level: info
```

### Step 3: Test the Backend

```bash
# Check health
curl http://localhost:4000/api/health

# Get agents
curl http://localhost:4000/api/agents

# Get all calls (processes S3 files)
curl http://localhost:4000/api/calls

# Get audit rubrics
curl http://localhost:4000/api/prompts
```

## API Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `GET` | `/api/health` | Check service status and configuration |
| `GET` | `/api/agents` | Get list of all agents |
| `GET` | `/api/calls` | Fetch S3 files, transcribe, audit, return results |
| `GET` | `/api/prompts` | Get all audit prompt sets (rubrics) |
| `PATCH` | `/api/prompts/:id` | Update a prompt set criteria/weights |
| `POST` | `/api/audit` | Audit a specific file on-demand |

## S3 File Requirements

Files in S3 must follow this naming pattern:

```
agent-{5-6 digits}-{anything}-{10 digit phone}.{format}

Examples:
  agent-001-20260515-1000-5551234567.mp3
  agent-567-call-log-20260515-9876543210.wav
```

The parser extracts:
- **Agent ID**: First 5-6 digits after "agent-" → stored as `AGT{ID}`
- **Phone**: Last 10 consecutive digits → stored as customer phone

## Frontend Connection

The frontend already connects to this backend! Just start both:

```bash
# Terminal 1: Backend
cd CX-audit-backend && npm run dev

# Terminal 2: Frontend  
cd CX-audit-dashboard && npm run dev
```

The frontend is configured to call `http://localhost:4000/api` (see `.env.local`).

## Environment Variables Explained

| Variable | Required | Example | Notes |
|----------|----------|---------|-------|
| `PORT` | No | `4000` | Server port |
| `NODE_ENV` | No | `development` | `production` for deployment |
| `LOG_LEVEL` | No | `info` | `debug`, `info`, `warn`, `error` |
| `AWS_REGION` | Yes | `us-east-1` | AWS region for S3 |
| `AWS_ACCESS_KEY_ID` | Yes | `AKIA...` | AWS IAM access key |
| `AWS_SECRET_ACCESS_KEY` | Yes | `wJal...` | AWS IAM secret key |
| `S3_BUCKET_NAME` | Yes | `my-calls-bucket` | S3 bucket name |
| `S3_PREFIX` | No | `calls/` | Optional: filter to folder |
| `OPENAI_API_KEY` | Yes | `sk-proj-...` | OpenAI API key |
| `OPENAI_TRANSCRIPTION_MODEL` | No | `whisper-1` | Whisper model |
| `OPENAI_AUDIT_MODEL` | No | `gpt-4-turbo-preview` | GPT-4 model |

## Troubleshooting

### "S3_BUCKET_NAME not configured"
- Error: Backend starts but `/api/calls` returns empty array
- **Fix**: Add `S3_BUCKET_NAME` to `.env.local` and restart

### "OPENAI_API_KEY not configured"
- Warning: Backend returns stub audit scores instead of real scores
- **Fix**: Add `OPENAI_API_KEY` to `.env.local` and restart

### "Access Denied" from AWS
- Error: Cannot list S3 bucket
- **Fix**: Verify AWS credentials, check IAM permissions for `s3:ListBucket` and `s3:GetObject`

### "Invalid audio file" from OpenAI
- Error: Transcription fails for a specific file
- **Fix**: Verify file is a valid audio format (MP3, WAV, M4A) and not corrupted

### Port 4000 already in use
- Error: `listen EADDRINUSE :::4000`
- **Fix**: Change `PORT` in `.env.local` or kill existing process: `lsof -ti:4000 | xargs kill -9`

## File Structure

```
CX-audit-backend/
├── src/
│   ├── index.ts        # Express server & routes
│   ├── types.ts        # TypeScript interfaces
│   ├── data.ts         # Seed data (agents, prompts)
│   ├── env.ts          # Environment validation
│   ├── logger.ts       # Logging utility
│   ├── s3.ts           # S3 file operations
│   ├── openai.ts       # Transcription & auditing
│   └── validation.ts   # Input validation
├── .env.local          # Configuration (DO NOT COMMIT)
├── package.json        # Dependencies
├── tsconfig.json       # TypeScript config
├── dist/               # Compiled JavaScript (generated)
└── README.md          # Full documentation
```

## Next Steps

1. **Add S3 credentials** to `.env.local`
2. **Add OpenAI API key** to `.env.local`
3. **Start backend**: `npm run dev`
4. **Start frontend**: In another terminal, `cd ../CX-audit-dashboard && npm run dev`
5. **Test**: Open http://localhost:5173 (frontend) and log in with an agent email
6. **See calls**: Dashboard displays audited calls with scores and flags

## Production Checklist

Before deploying to production:

- [ ] Update `NODE_ENV=production` in `.env.local`
- [ ] Set `LOG_LEVEL=error` to reduce log volume
- [ ] Move secrets to environment manager (AWS Secrets Manager, etc.)
- [ ] Set `S3_PREFIX` to filter large buckets
- [ ] Enable CORS for specific frontend domain
- [ ] Use PM2 or similar process manager
- [ ] Set up monitoring and alerting
- [ ] Configure HTTPS
- [ ] Add rate limiting middleware
- [ ] Test `/api/health` endpoint regularly
- [ ] Back up audit data and transcripts

## Support

See [README.md](./README.md) for detailed API documentation and architecture details.
