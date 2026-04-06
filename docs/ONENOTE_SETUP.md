# OneNote MCP Setup

Lets Medusa read, search, and create OneNote pages via Claude tool calls.

**Time required: ~10 minutes**

---

## Step 1 — Register an Azure app

1. Go to **https://portal.azure.com**
2. Sign in with your Microsoft account (same one with OneNote)
3. Search for **Azure Active Directory** → click it
4. Left menu → **App registrations** → **New registration**
5. Fill in:
   - Name: `Medusa`
   - Supported account types: **Accounts in this organizational directory only** (or "any tenant" if sharing)
   - Redirect URI: leave blank
6. Click **Register**
7. Copy the **Application (client) ID** → this is your `AZURE_CLIENT_ID`
8. Copy the **Directory (tenant) ID** → this is your `AZURE_TENANT_ID`

---

## Step 2 — Create a client secret

1. Left menu → **Certificates & secrets** → **New client secret**
2. Description: `Medusa OneNote`
3. Expiry: 24 months (or your preference)
4. Click **Add**
5. Copy the **Value** immediately (it's only shown once) → this is your `AZURE_CLIENT_SECRET`

---

## Step 3 — Grant OneNote permissions

1. Left menu → **API permissions** → **Add a permission**
2. Choose **Microsoft Graph** → **Application permissions**
3. Search and add:
   - `Notes.Read`
   - `Notes.ReadWrite`
   - `Notes.ReadWrite.All`
4. Click **Add permissions**
5. Click **Grant admin consent for [your org]** → confirm

---

## Step 4 — Add to .env

Open `.env` in the Medusa repo root and add:

```
AZURE_TENANT_ID=your-tenant-id-here
AZURE_CLIENT_ID=your-client-id-here
AZURE_CLIENT_SECRET=your-client-secret-here
```

---

## Step 5 — Restart Claude Code

The OneNote MCP server reads env vars at startup. Restart Claude Code after editing `.env`.

---

## Verify

Ask Medusa: *"List my OneNote notebooks"* — it should return your notebook names.

---

## Troubleshooting

| Error | Fix |
|-------|-----|
| `401 Unauthorized` | Check AZURE_CLIENT_ID / SECRET are correct |
| `403 Forbidden` | Admin consent not granted — redo Step 3 |
| `AADSTS700016` | Tenant ID wrong or app not found |
| No notebooks returned | Ensure the account has OneNote notebooks in OneDrive |
