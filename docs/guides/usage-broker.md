# Live usage from your provider (usage broker)

Status: DRAFT user instructions for a proposed feature (PRD v1.3 draft, S-41, FR-56, CRED1..CRED10). Not built yet.
Provider-specific steps are filled in after spike S16; until then this page describes the rules every provider follows.

## What it does

By default Xaibo only reads what your agents already write on your machine, so quota and usage can lag between agent
updates. The usage broker is an optional, separate part of Xaibo that asks your provider directly for your current
quota and usage. It is off until you turn it on, for one profile and one provider at a time.

Turning it on is the only way Xaibo connects to the internet. Everything else in Xaibo stays local.

## Ways to connect, safest first

Xaibo offers the safest method a provider supports (CRED2):

1. **The agent reports for you.** Xaibo asks the agent's own tool to report its usage. The agent makes the request with
   its own sign-in; Xaibo never sees a secret. Offered only where Xaibo verified that the agent's report makes no
   model call, refreshes no token and changes nothing.
2. **Your own key, from the provider's documented API.** For API-key accounts. You create a key and paste it into Xaibo.
3. **Your agent's sign-in (Experimental).** Only where neither of the above exists. Xaibo reads the agent's stored
   sign-in at the moment of each request, uses it only inside the usage broker, and never stores it. (It stays in
   that process's memory until the system reclaims it; this cannot be wiped instantly.) Labeled Experimental because the provider endpoint
   is not documented and can change.

Before you turn anything on, Xaibo shows which host it will contact, which credential it uses, what data it reads and
how often.

## If you use your own key

- **Create a dedicated key for Xaibo.** Name it so you recognize it (for example "Xaibo usage"). Do not reuse a key that
  other tools or scripts use.
- **Give it the narrowest scope your provider offers.** If the provider can limit a key to reading usage or billing
  data, choose that. Some providers only offer usage data to organization admin keys, which can do much more; treat
  such a key as highly sensitive.
- **Paste it into Xaibo's key field, nowhere else.** The field sends it once to the usage broker and clears itself. Never put it in a project file, a `.env` file in a repository, or a chat.
- **Rotate it regularly** (every 90 days is a good habit) and right away if you think it leaked: create a new key, paste
  it into Xaibo, then revoke the old one at the provider.
- **To remove it,** use Remove key in Xaibo, then revoke it at the provider.

What Xaibo does with your key:

- Encrypts it with your operating system's protection (macOS Keychain-held key, Windows DPAPI, Linux secret service).
  If your system only offers unprotected storage, Xaibo refuses to store the key.
- Keeps the encrypted copy in a private file in Xaibo's app data, never in its database, backups, exports, logs,
  diagnostics or answers to agents (MCP).
- Uses it only inside the usage broker, only for the provider's usage requests on its allowlist.
- Shows it only as its last 4 characters.

## If you use your agent's sign-in (Experimental)

- On macOS, macOS asks whether Xaibo may read the agent's sign-in from the Keychain. If you deny or cancel, Xaibo stops
  using this method for that profile until you turn it on again. Which choice to make and how often macOS asks are
  described here once they are verified (spike S16). This method needs a signed Xaibo build.
- Xaibo never changes, refreshes or deletes the agent's sign-in. If it has expired, Xaibo shows "Sign in again in
  <agent>"; sign in in the agent and Xaibo picks it up on the next refresh.
- Check your provider's terms. Xaibo enables this method for a provider only after the owner records a terms review
  (CRED7), but the decision to use it is yours.

## Turning it off

- Turn off one provider for one profile in that profile's usage settings.
- Turn off all network features with one switch; Xaibo then makes no internet connections at all.
- Readings already collected stay in your history under Xaibo's usual retention rules.

## How often it checks

Every 5 minutes by default; you can change this down to once a minute or press Refresh. When the provider says to slow
down, Xaibo waits longer. If the provider rejects the sign-in or key, Xaibo stops asking and tells you why.

## Seeing what it did

The usage settings list each request: time, provider, which endpoint, result and how long it took. Requests never show
headers, bodies or secrets.

## Messages you may see

| Message | Meaning | What to do |
|---|---|---|
| Sign in again in <agent> | The agent's sign-in expired or was revoked | Sign in in the agent |
| Key rejected | The provider refused your key | Check it at the provider; paste a new key |
| Provider changed | The provider's response no longer matches what Xaibo expects | Nothing; Xaibo keeps showing passive readings until an update |
| Waiting (rate limited) | The provider asked Xaibo to slow down | Nothing; Xaibo retries later |
| Unavailable: no protected storage | Your system has no OS secret protection | Use method 1 or 3, or enable a secret service (Linux) |
| Keychain access denied | You denied or cancelled the macOS prompt | Turn the method on again to be asked once more |
| Account scope unverified | Xaibo cannot tell which provider account this sign-in belongs to | Nothing; readings stay separate per profile |
