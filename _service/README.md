# Homology application service

The public site (`index.html`, served by GitHub Pages) is a static page and cannot keep anything private. This small service does the two things the page cannot:

1. **Receives applications** from the form on homology.bio and stores them privately as "Pending review".
2. **Serves the review view** at `/review`, where authorized reviewers read applications, decide, keep private notes and record Slack invitations.

The folder name starts with an underscore so GitHub Pages leaves it out of the published site.

## The flow, and what is kept separate

| Step | Who | What happens | What does not happen |
| --- | --- | --- | --- |
| Apply | Anyone | One record is stored with status `pending` | No Slack access, no email, no sign-in |
| Decide | A reviewer | Status becomes `approved` or `declined`, with who and when | Nobody is invited |
| Invite | A reviewer, only after approval | The reviewer invites that one email address in Slack by hand, then records it here | No shared invite link is ever used |

Rules the server enforces (see `src/applications.js`, covered by `test/flow.test.js`):

- A new application is always `pending`. Anything else an applicant sends is ignored.
- An invitation can only be recorded while the application is `approved`.
- While an invitation is on record, the decision cannot be changed. Revoke the invitation in Slack and clear the record first.
- Every decision, note edit and invitation record is stored with the reviewer's email and the time, in the application's history.
- Dinner requests live in Luma. Nothing here reads them, so a dinner request or approval cannot create a membership.

### Slack

Slack only offers an API for sending workspace invitations on Enterprise Grid, so this service does not send them. After approval the review view shows a manual step: open `https://homologybio.slack.com/admin/invites`, invite the applicant's email as a member, then press "Record invitation sent". The service makes no calls to Slack at all.

`https://homologybio.slack.com` on the public page is a sign-in address for existing members. It is not an invitation. Do not publish or paste a reusable invite link anywhere.

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
| `GOOGLE_CLIENT_ID` | yes | OAuth client ID (type "Web application") used for Google sign-in. |
| `SESSION_SECRET` | yes | At least 32 random characters. Signs the reviewer session cookie. Keep it in Secret Manager. |
| `ALLOWED_ORIGINS` | no | Sites allowed to post applications. Default `https://homology.bio`. |
| `SITE_URL` | no | Where the "Back to Homology" link points. Default `https://homology.bio/`. |
| `SLACK_WORKSPACE_URL` | no | Default `https://homologybio.slack.com`. |
| `FIRESTORE_DATABASE` | no | Default `homology`. |
| `FIRESTORE_COLLECTION` | no | Default `applications`. |

## Deploy (Cloud Run + Firestore)

Replace `PROJECT_ID`. Use a project whose owners are all people who may read applications, because project owners can read its databases.

1. Create the private database and a service identity that can only use it:

   ```bash
   gcloud firestore databases create --project PROJECT_ID --database homology --location us-east4 --type firestore-native
   gcloud iam service-accounts create homology-applications --project PROJECT_ID
   gcloud projects add-iam-policy-binding PROJECT_ID \
     --member serviceAccount:homology-applications@PROJECT_ID.iam.gserviceaccount.com \
     --role roles/datastore.user \
     --condition 'title=homology-db-only,expression=resource.name.startsWith("projects/PROJECT_ID/databases/homology")'
   ```

2. Create the session secret:

   ```bash
   openssl rand -hex 32 | gcloud secrets create homology-session-secret --project PROJECT_ID --data-file=-
   gcloud secrets add-iam-policy-binding homology-session-secret --project PROJECT_ID \
     --member serviceAccount:homology-applications@PROJECT_ID.iam.gserviceaccount.com --role roles/secretmanager.secretAccessor
   ```

3. In the Google Cloud console, under APIs and Services, Credentials, create an OAuth client ID of type "Web application". The consent screen must allow external users if any reviewer uses a personal Gmail account. Leave the origins empty for now.

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

- It does not email applicants. "We will email you with next steps" is a promise the reviewers keep by hand.
- It does not notify reviewers of new applications. Open `/review` to see what is pending.
- It does not check whether an invited person has joined Slack. A reviewer marks that.
- It does not delete applications. Remove a record in the Firestore console if one must go.
