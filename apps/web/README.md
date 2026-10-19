# MailPilot Web

Next.js frontend for the MailPilot email scheduler. The active navigation is Compose, Scheduled, Sent, Failed, Cancelled, Lists, and Groups. Campaign UI/API features are intentionally out of scope.

Run from the repository root:

```powershell
npm run dev:web
```

Configure `NEXT_PUBLIC_API_URL` in your local `.env.local` (for example `http://localhost:3000`) if the API is not at the default URL.
