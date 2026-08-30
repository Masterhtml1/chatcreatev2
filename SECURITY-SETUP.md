# Admin authentication setup

The admin password used to be the string `'skid'`, written into `index.html`
and `admin.html`. Anyone who opened View Source had full admin.

It now lives in a **Firebase Authentication account**. The browser sends the
typed password to Google, Google says yes or no, and the database only accepts
admin writes from a signed-in account listed under `/admins`. Nothing in this
repository reveals the password.

**Admin login will not work until you finish the four steps below.** Do them
before deploying, or you will lock yourself out of the dashboard.

---

## 1. Turn on Email/Password sign-in

Firebase console → your project (`chatcreate-5dfd6`) → **Authentication** →
*Sign-in method* → **Email/Password** → Enable → Save.

## 2. Create the admin account

Authentication → *Users* → **Add user**

- Email: `admin@chatcreate.app`
- Password: pick a real one — this becomes the admin password

If you use a different email, change `ADMIN_EMAIL` at the top of `auth.js` to
match. The address is not a secret and does not need to receive mail; only the
password matters.

Copy the **User UID** shown in the users table.

## 3. Register that UID as an admin

Realtime Database → *Data* → add this node at the root:

```
admins
  └── <the UID you copied>: true
```

The sign-in code checks `/admins/<uid>` after authenticating, so an account
that is not listed here is rejected even with the right password.

## 4. Publish the security rules

Realtime Database → *Rules* → paste the contents of `database.rules.json` →
**Publish**.

This is the step that actually secures anything. Without it the database still
accepts writes from anybody, no matter how the login screen behaves.

---

## What the rules enforce

Admin-only writes (require a signed-in `/admins` account):

| Data | Why it matters |
| --- | --- |
| `approvedEmails` | who is allowed into the chat |
| `bannedWords` | the content filter |
| `settings` | auto-approve and filter toggles |
| `modPasswords` | issuing and revoking moderator codes |
| `channels` (delete) | clearing channels and messages wholesale |
| `failedAttempts`, `adminNotifications` | read access, and clearing them |
| `admins` | nobody can write this from a browser — console only |

Still open to everyone, because the app needs it without login: posting
messages, typing indicators, presence, submitting a moderator report, logging a
failed attempt, and the ban list (moderators ban without a Firebase account).

## Known weaknesses this does not fix

- **Moderator codes are stored in plaintext and are world-readable.** The mod
  login has to search `modPasswords` by value from an unauthenticated browser,
  so the node must stay readable. Anyone who opens the database URL can read
  the codes. Fixing this properly means giving moderators real accounts too.
- **Anyone can still ban a user or file a moderator report**, since moderators
  act without a Firebase account.
- **Individual `failedAttempts` entries can be deleted by anyone** who knows
  the key, so a determined attacker can tidy up after themselves.

Each of these needs the same treatment as the admin password: a real account
per moderator, then rules keyed on that account. Happy to do that next.
