# Vercel frontend with Google Cloud backend

Import the repository with its root directory unchanged. `vercel.json` builds `client` and publishes
`client/dist`. API requests and the issuer DID document are forwarded to the existing Cloud Run service.
MongoDB, AI/voice services, background workers, and the coding runner remain in Google Cloud.

Before promoting a Vercel deployment:

- Restore project billing and verify the Cloud Run API and database are healthy.
- Set the Cloud Run app's `CLIENT_ORIGIN` to the exact stable Vercel production HTTPS origin.
  Browser writes from other origins are deliberately rejected. Preview URLs are not automatically trusted.
- Set `EMAIL_DELIVERY_ENABLED=false` on Cloud Run. Delivery now defaults off even if SMTP credentials exist.
  Do not add backend secrets to Vercel's frontend build environment.
- Preserve the existing service identity, secret references, deletion-ledger bucket, worker, models and runner.
- Verify login/logout, cookies, CSRF rejection, refresh/deep links, disabled account email, and all enabled
  feature flows through the Vercel production URL. A static frontend deployment is not a healthy full app.

Cloud Run's old frontend origin will no longer accept browser writes after switching `CLIENT_ORIGIN`.
Roll back both the frontend deployment and backend origin together if switching traffic fails.

Long synchronous AI requests and large uploads must be checked against Vercel proxy limits; asynchronous
interview jobs continue to run on Cloud Run independently of the frontend connection.
