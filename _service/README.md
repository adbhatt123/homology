# Homology application service

The public site (`index.html`, served by GitHub Pages) is a static page and cannot keep anything private. This small service does the two things the page cannot:

1. **Receives applications** from the form on homology.bio and stores them privately as "Pending review".
2. **Serves the review view** at `/review`, where authorized reviewers read applications, decide, keep private notes and record Slack invitations.
3. **Optionally posts each application to the reviewers' private Slack channel**, where the same reviewers can decide with buttons. See "Review in Slack" below.

The folder name starts with an underscore so GitHub Pages leaves it out of the published site.

## The flow, and what is kept separate

| Step | Who | What happens | What does not happen |
| --- | --- | --- | --- |
| Apply | Anyone | One record is stored with status `pending` | No Slack access, no email, no sign-in |
| Call (optional) | A reviewer | Status becomes `call`. The reviewer emails the applicant an invite to a short intro call from their own inbox, then records that it went out | Nothing is decided and nobody is invited |
| Decide | A reviewer | Status becomes `approved` or `declined`, with who and when. This can follow a call or skip it | Nobody is invited |
| Tell them | A reviewer | The reviewer sends a welcome or a decline email from their own inbox, then records that it went out | Nobody is invited. The welcome email holds no link |
| Invite | A reviewer, only after approval | The reviewer invites that one email address in Slack by hand, then records it here | No shared invite link is ever used |

Rules the server enforces (see `src/applications.js`, covered by `test/flow.test.js`):

- A new application is always `pending`. Anything else an applicant sends is ignored.
- A call invite can only be recorded while the application is at the `call` stage. A call, however it goes, grants nothing.
- A welcome email can only be recorded for an `approved` application, and a decline email for a `declined` one. If the decision changes later the record stays, because the email did go out.
- An invitation can only be recorded while the application is `approved`.
- While an invitation is on record, the decision cannot be changed. Revoke the invitation in Slack and clear the record first.
- Every decision, note edit and invitation record is stored with the reviewer's email and the time, in the application's history.
- Dinner requests live in Luma. Nothing here reads them, so a dinner request or approval cannot create a membership.

### The intro call

Reviewers can move an application to an intro call before deciding. The idea is a 15 minute conversation to learn what the person is working on and who they want to meet, so introductions are better. It is optional per application: "Approve without a call" and "Decline" stay available from the start.

At the call stage the review view and the Slack message offer two steps:

1. **Write the invite.** A link opens a ready-to-send draft in the reviewer's own Gmail, addressed to the applicant. This service never sends email. The wording is in `src/emails.js`.
2. **Record call invite sent.** So the other reviewers know. It can be cleared if pressed by mistake.

After the call, the reviewer writes what they learned in the private notes, then approves or declines.

**Adding the booking link.** Until a link is set, the draft asks the applicant to suggest a couple of times. To switch to a booking link, add one line to `_service/env.yaml` and deploy:

```yaml
CALL_BOOKING_URL: "https://cal.com/your-name/intro"
```

Nothing else changes: the draft then says "You can pick a time here:" followed by the link, in both the review view and Slack.

### Welcome and decline emails

After a decision the review view and the Slack message offer one more step, the same way as the call invite: a link opens a ready-to-send draft in the reviewer's own Gmail, and a button records that it went out. This service never sends email.

- **Welcome**, after an approval. It says they are in and that a Slack invitation follows at the same address. Send it before or right after the invitation, since the invitation itself comes from Slack and says nothing about Homology.
- **Decline**, after a decline. It is short and gives no reason, because the service cannot know the real one. Add one in the draft if you want to.

The wording of all three emails is in `src/emails.js`. A record made by mistake is cleared in the review view.

### Slack invitations

Slack only offers an API for sending workspace invitations on Enterprise Grid, so this service does not send them. After approval the review view shows a manual step: open `https://homologybio.slack.com/admin/invites`, invite the applicant's email as a member, then press "Record invitation sent". Nothing in this service can invite anyone to Slack, with or without the Slack review below.

`https://homologybio.slack.com` on the public page is a sign-in address for existing members. It is not an invitation. Do not publish or paste a reusable invite link anywhere.

## Review in Slack

When the Slack settings are present, each new application is posted to one private channel, and reviewers can press Move to call, Approve, Decline, Move back to pending, Record call invite sent, Record welcome email sent, Record decline email sent, Record invitation sent, Mark as joined, Clear invitation record and Add note there. A decision made in Slack and one made in the review view are the same thing: same rules, same record of who and when (Slack changes are marked `via: slack` in the history), and the Slack message is redrawn after every change from either place.

What keeps this private and safe (see `src/slack.js`, covered by `test/slack.test.js`):

- **Only reviewers see answers.** Before posting, the service checks that the channel is private, is not shared with another organization, and has no member other than the app itself and the reviewers in `SLACK_REVIEWERS`. If any check fails, it posts a short notice with a link to the review view and no answers.
- **Only reviewers can decide.** Every button press must carry Slack's signature, come from the Homology workspace and that channel, and be made by someone listed in `SLACK_REVIEWERS` whose email is also in `ADMIN_EMAILS`. Anyone else gets a private "you are not set up to review" reply and nothing changes. Removing someone from `ADMIN_EMAILS` stops their Slack buttons at once.
- **Answers cannot act on Slack.** What applicants wrote is sent as plain text only, so it cannot ping the channel, mention people, disguise a link or change formatting. The phone notification says "New Homology application" and names nobody.
- **Applying still grants nothing.** The application is saved before Slack is contacted. If Slack is down, the applicant still gets the thank-you line, the application is in the review view, and it is posted to Slack the next time it changes.
- **Approval still invites nobody.** After approval the message shows the same manual step as the review view. The app has no permission that could send an invitation.

The app's permissions are `chat:write` and `groups:read`. It cannot read messages or member emails.

### Set it up

1. Create a private channel for reviewers only, for example `#applications`. Add the reviewers and nobody else.
2. Go to https://api.slack.com/apps, choose Create New App, From a manifest, pick the Homology workspace and paste `slack-app-manifest.yaml`. Install it to the workspace.
3. In the reviewers channel, type `/invite @Homology Applications`.
4. Store the app's two secrets. Copy each one in Slack, then run the matching command so the value goes from the clipboard straight into Secret Manager and never into a file or a chat:

   ```bash
   # "Bot User OAuth Token" on the app's OAuth & Permissions page
   pbpaste | gcloud secrets create homology-slack-bot-token --project PROJECT_ID --data-file=-
   # "Signing Secret" on the app's Basic Information page
   pbpaste | gcloud secrets create homology-slack-signing-secret --project PROJECT_ID --data-file=-
   ```

   Then let the service read them:

   ```bash
   for name in homology-slack-bot-token homology-slack-signing-secret; do
     gcloud secrets add-iam-policy-binding "$name" --project PROJECT_ID \
       --member serviceAccount:homology-applications@PROJECT_ID.iam.gserviceaccount.com --role roles/secretmanager.secretAccessor
   done
   ```

5. Add three lines to `_service/env.yaml`. The channel ID is the last part of the channel's link (right-click the channel, Copy link). A member ID is under the three dots on that person's Slack profile, Copy member ID.

   ```yaml
   SERVICE_URL: "https://homology-applications-PROJECT_NUMBER.us-east4.run.app"
   SLACK_REVIEW_CHANNEL: "C0123456789"
   SLACK_REVIEWERS: "U012ABCDEF=first.reviewer@example.org,U045GHIJKL=second.reviewer@example.org"
   ```

6. Deploy as in step 5 of "Deploy" below, with the two secrets added:

   ```bash
   --set-secrets SESSION_SECRET=homology-session-secret:latest,SLACK_BOT_TOKEN=homology-slack-bot-token:latest,SLACK_SIGNING_SECRET=homology-slack-signing-secret:latest
   ```

7. Check it with a made-up application: submit it on the site, see it appear in the channel, press Approve, then Decline, and confirm the review view shows the same. Delete the made-up record afterwards.

To add a reviewer later: add them to the channel, to `SLACK_REVIEWERS`, to `ADMIN_EMAILS` and to the Google test users, then deploy. To turn Slack review off, remove the Slack lines from `env.yaml` and the two Slack secrets from the deploy command.

Two things to expect. The first button press after a quiet spell can show a small warning in Slack, because the service takes a few seconds to wake and Slack only waits three; the change still goes through and the message updates. And anyone added to the reviewers channel who is not a reviewer can read what is already there, so keep the channel to reviewers.

## Run it locally

```bash
npm install
npm test
npm run dev
```

`npm run dev` starts the service on port 4180 with an in-memory store mirrored to `.data/` and a local-only sign-in form. Serve the repository root on port 4178 (for example `python3 -m http.server 4178`) and the form on the page posts to the local service. The local sign-in accepts the placeholder reviewers in the `dev` script. It does not exist in production: the service refuses to start if `ALLOW_DEV_LOGIN` is set there.

## Settings

| Variable | Required in production | Purpose |
| --- | --- | --- |
| `ADMIN_EMAILS` | yes | Comma-separated Google accounts allowed into the review view. Checked on every request, so removing an address takes effect at once. |
| `GOOGLE_CLIENT_ID` | for review | OAuth client ID (type "Web application") used for Google sign-in. Until it is set, applications are still received but nobody can open the review view. |
| `SESSION_SECRET` | yes | At least 32 random characters. Signs the reviewer session cookie. Keep it in Secret Manager. |
| `ALLOWED_ORIGINS` | no | Sites allowed to post applications. Default `https://homology.bio`. |
| `SITE_URL` | no | Where the "Back to Homology" link points. Default `https://homology.bio/`. |
| `SLACK_WORKSPACE_URL` | no | Default `https://homologybio.slack.com`. |
| `FIRESTORE_DATABASE` | no | Default `(default)`, the project's own database. |
| `FIRESTORE_COLLECTION` | no | Default `applications`. |
| `CALL_BOOKING_URL` | no | Where applicants book the intro call, as an https link. Until it is set, the call invite asks them to suggest times. |
| `SERVICE_URL` | for Slack | This service's own https address. Used for the "Open in review view" link. |
| `SLACK_BOT_TOKEN` | for Slack | The Slack app's bot token. Keep it in Secret Manager. |
| `SLACK_SIGNING_SECRET` | for Slack | Proves a button press came from Slack. Keep it in Secret Manager. |
| `SLACK_REVIEW_CHANNEL` | for Slack | ID of the reviewers' private channel. |
| `SLACK_REVIEWERS` | for Slack | `SlackMemberID=email` pairs, separated by commas. Each email must also be in `ADMIN_EMAILS`. |
| `SLACK_TEAM_ID` | no | Default `T0CJTMG3DT8`, the Homology workspace. Presses from any other workspace are refused. |

The five "for Slack" settings go together: the service refuses to start with only some of them.

## Deploy (Cloud Run + Firestore)

Production runs in the Google Cloud project `homology-bio`, at `https://homology-applications-1032824467826.us-east4.run.app`. The steps below are how it was set up. Use a project whose owners are all people who may read applications, because project owners can read its databases.

1. Create the private database, a service identity for this service, and let the project's build account build it:

   ```bash
   gcloud firestore databases create --project PROJECT_ID --location us-east4 --type firestore-native
   gcloud iam service-accounts create homology-applications --project PROJECT_ID
   gcloud projects add-iam-policy-binding PROJECT_ID \
     --member serviceAccount:homology-applications@PROJECT_ID.iam.gserviceaccount.com --role roles/datastore.user
   gcloud projects add-iam-policy-binding PROJECT_ID \
     --member serviceAccount:PROJECT_NUMBER-compute@developer.gserviceaccount.com --role roles/run.builder
   ```

2. Create the session secret:

   ```bash
   openssl rand -hex 32 | gcloud secrets create homology-session-secret --project PROJECT_ID --data-file=-
   gcloud secrets add-iam-policy-binding homology-session-secret --project PROJECT_ID \
     --member serviceAccount:homology-applications@PROJECT_ID.iam.gserviceaccount.com --role roles/secretmanager.secretAccessor
   ```

3. In the Google Cloud console, open Google Auth Platform. Set it up with audience "External" (needed if any reviewer uses a personal Gmail account), then under Clients create a client of type "Web application". Leave the origins empty for now. The app stays in "Testing", so under Audience add every reviewer as a test user. A reviewer has to be in both places: the test users in Google and `ADMIN_EMAILS` here.

4. Write `_service/env.yaml` (it is ignored by git):

   ```yaml
   ADMIN_EMAILS: "first.reviewer@example.org,second.reviewer@example.org"
   GOOGLE_CLIENT_ID: "xxxxxxxx.apps.googleusercontent.com"
   ```

5. Deploy:

   ```bash
   gcloud run deploy homology-applications --project PROJECT_ID --region us-east4 \
     --source _service \
     --service-account homology-applications@PROJECT_ID.iam.gserviceaccount.com \
     --env-vars-file _service/env.yaml \
     --set-secrets SESSION_SECRET=homology-session-secret:latest \
     --allow-unauthenticated --max-instances 2
   ```

6. Add the service URL that Cloud Run prints to the OAuth client's "Authorized JavaScript origins".

7. Put `SERVICE_URL/api/apply` in the `action` of the form in `index.html`, then publish the page.

8. Check production with a made-up application: submit it on the site, sign in at `SERVICE_URL/review`, confirm it is pending, then decline it. Do not invite a real person as a test.

## What this does not do

- It does not email applicants. "We will email you with next steps" is a promise the reviewers keep by hand. For the intro call, the welcome and the decline it writes the draft, and a reviewer sends it.
- It does not schedule calls or know whether one happened. The booking link, once set, is only text in the invite.
- It does not notify reviewers of new applications unless Slack review is set up. Without it, open `/review` to see what is pending.
- It does not send Slack invitations, with or without Slack review.
- It does not check whether an invited person has joined Slack. A reviewer marks that.
- It does not delete applications. Remove a record in the Firestore console if one must go.
