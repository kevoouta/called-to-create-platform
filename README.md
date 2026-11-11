# called-to-create-platform
An online creative edtech platform.

## Paystack checkout

The course and digital-asset cart drawers open Paystack Inline checkout in a popup through the `paystack-checkout` Supabase Edge Function. The function calculates prices from Supabase, verifies completed transactions with Paystack, and records successful orders. Course orders also create the corresponding enrollment. Never put the Paystack secret key in browser code.

Before deploying:

1. Apply all pending migrations to the Supabase project. This includes the payment-order schema and private shop and course asset delivery.
   From the repository root, this can be done with:

   ```sh
   supabase link --project-ref ecbftpfbbfvcxreszsfo
   supabase db push --remote
   ```

   Alternatively, run each pending migration in the Supabase SQL Editor, in timestamp order.
2. Set the Paystack secret key and every permitted local/production site origin:

   ```sh
   supabase secrets set PAYSTACK_SECRET_KEY=sk_test_your_key ALLOWED_ORIGINS=http://localhost:5502,http://127.0.0.1:5502,https://your-site.example
   ```

3. Deploy the function:

   ```sh
   supabase functions deploy paystack-checkout
   ```

4. In the Paystack dashboard, configure the webhook URL as `https://ecbftpfbbfvcxreszsfo.supabase.co/functions/v1/paystack-checkout`.

## Shop asset delivery

The shop delivery migration adds `products.storage_path` and creates the private `shop-deliverables` bucket. For each shop item:

1. In Supabase Dashboard, open **Table Editor** → `products` and create the product row. Set its title and KES price; add a description, category, and image URL as needed by the shop card. Keep any generated ID and timestamp values.
2. Open **Storage** → `shop-deliverables` and upload the deliverable file. Note the object path shown in the bucket; for example, `luts/film-look.zip`.
3. Save that object path to `storage_path` on the product row. For example:

```sql
update public.products
set storage_path = 'luts/film-look.zip'
where id = 'PRODUCT_ID';
```

Replace both example values with the real object path and product ID. Repeat for every downloadable shop product. The item appears in `shop.html`; after a verified purchase it is marked as purchased and the customer can download it from **My Library**. Downloads are available only after the server confirms a paid order; the function creates a short-lived signed URL. Course enrollments and their existing course assets remain separate and continue to appear in the library.

Use the Paystack test secret key while testing, then replace it with the live secret key for production. The origins must include the exact origin (scheme, hostname, and port) used to open the site; the same list also restricts Paystack's return URL. The function verifies the Paystack webhook signature and checks transactions directly with Paystack before recording payment. Successful orders are stored in `payment_orders`.

## Course video streams

Apply the `20261111100000_protect_course_content.sql` migration before deploying the `course-content` function or the updated `course.html`. The migration moves lesson definitions, video URLs, and course assets from `courses` into the RLS-protected `course_private_content` table, removes lesson video URLs from public course rows, and creates the private `course-deliverables` storage bucket. Only the Edge Function accesses protected content with the service-role key, after it verifies the signed-in user's enrollment.

The course preview in `courses.preview_video_url` is intentionally public. Keep paid lesson streams out of this field. The `course-content` function signs public previews without requiring enrollment, and signs lessons from `course_private_content.curriculum` only after enrollment verification. Lesson video URLs must use the Bunny Stream embed format `https://iframe.mediadelivery.net/embed/LIBRARY_ID/VIDEO_ID`.

Deploy the new access flow before turning on Bunny's token enforcement:

1. Set the library ID and **Token authentication key** as Edge Function secrets. Use the same exact site origins already configured for `ALLOWED_ORIGINS`:

   ```sh
   supabase secrets set BUNNY_STREAM_LIBRARY_ID=YOUR_LIBRARY_ID BUNNY_STREAM_TOKEN_AUTH_KEY=YOUR_TOKEN_AUTH_KEY
   ```

2. Deploy the function and updated static site:

   ```sh
   supabase functions deploy course-content
   ```

3. Move every course download into the private `course-deliverables` bucket. In Supabase Dashboard, upload the file and set its path on the matching entry in `course_private_content.assets` as `storage_path`. For example:

   ```sql
   update public.course_private_content
   set assets = jsonb_set(assets, '{0,storage_path}', '"course-id/resources/example.pdf"'::jsonb)
   where course_id = 'COURSE_ID';
   ```

   Replace the example path and course ID. Existing external asset links were moved out of the public course row, but they are not made private automatically; upload the files to the private bucket, update their `storage_path`, and remove or revoke the original public links.

4. In Bunny Stream, enable **Embed view token authentication** for the video library. Restrict allowed embed domains to the production site domain(s) as an additional safeguard. Do not use the library API key as the token-authentication key. This step makes any old unsigned lesson embeds stop working.

The function checks enrollment on every lesson-video and download request. It returns Bunny embed URLs with a 5-minute token and storage download URLs with a 5-minute expiry. A copied signed URL can still be used until it expires, and an enrolled user can record what they watch; domain restrictions and short expirations reduce sharing but cannot prevent screen recording.

## Admin dashboard

`admin.html` is an administrator-only operations dashboard for course, shop, enrollment, and Paystack order counts plus the latest ten order references and sampled Supabase query timings. Administrators can edit existing course and product records, including public course previews, protected lesson metadata, and private storage paths. Each save is applied with its audit entry in one database transaction. The dashboard does not expose customer emails, create or delete content, issue refunds, or call Paystack and Bunny APIs. The timing figures are per-request diagnostics, not historical site performance analytics.

To enable it:

1. Create or identify administrator accounts in Supabase Auth. Enable MFA for each administrator. Copy each administrator's Auth user UUID; do not use user-editable metadata to grant dashboard access.
2. Set the server-only `ADMIN_USER_IDS` Edge Function secret to the comma-separated UUID allowlist. Do not put this value in `admin.html` or a browser setting.

   ```sh
   supabase secrets set ADMIN_USER_IDS=ADMIN_AUTH_USER_UUID
   ```

3. Apply pending Supabase migrations in timestamp order. The admin content editor migration depends on the course private-content table from `20261111100000_protect_course_content.sql`.
4. Ensure `ALLOWED_ORIGINS` includes the exact production site origin (scheme, hostname, and port, with no path). Deploy the dashboard function and publish `admin.html` with the rest of the site:

   ```sh
   supabase functions deploy admin-dashboard
   ```

The browser uses only the existing Supabase publishable key. Each dashboard request verifies the Supabase session and checks its user UUID against `ADMIN_USER_IDS` on the server before reading or editing data with the service-role key. Database update functions are executable only by `service_role`; updates and audit snapshots are atomic. `verify_jwt = false` is intentional in `supabase/config.toml`: the function validates the bearer token with Supabase Auth itself, then applies the administrator allowlist. Never add provider secrets to this static page.
